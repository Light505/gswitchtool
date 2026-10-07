//! Live view of a delegated Codex task (added by Light505 for gswitchtool).
//! Codex writes each conversation to `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`
//! in its home folder as it happens. GSwitch follows that file for the window,
//! read-only, turning Codex's records into the steps a terminal would show:
//! the task, Codex's messages, commands and their output, file edits, and the
//! end. Nothing read here is stored or sent anywhere.

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// One read returns at most this much of the file; the next continues.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// Long text (command output, messages) is shortened to this many characters.
const MAX_TEXT_CHARS: usize = 6_000;
/// How many day folders, newest first, are searched for a thread's file.
const MAX_DAY_FOLDERS: usize = 60;

/// One step of a Codex task, as the window shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LogItem {
    /// The task Codex was given.
    Task { text: String },
    /// Something Codex wrote: a progress note or its final answer.
    Message { text: String },
    /// A summary of Codex's reasoning, when it writes one.
    Thinking { text: String },
    /// A command Codex ran.
    Command { text: String },
    /// Files Codex changed through a patch.
    Patch { files: Vec<String> },
    /// What a command or tool returned.
    Output { text: String },
    /// The turn finished.
    Done { seconds: Option<f64> },
    /// The turn was stopped before it finished.
    Stopped,
    /// Tokens used so far in this thread.
    Tokens {
        total: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cached_input_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_output_tokens: Option<u64>,
        total_tokens: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LogChunk {
    /// Whether Codex's file for the thread was found.
    pub found: bool,
    pub items: Vec<LogItem>,
    /// Where the next read continues.
    pub offset: u64,
}

/// The latest token totals recorded by Codex for a thread.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
}

/// Reads the tokens a thread used, without retaining rollout text. With
/// `since_ms` (Unix milliseconds), totals recorded before then are
/// subtracted, so a resumed thread counts only the newer work.
pub fn usage(codex_home: &Path, thread_id: &str, since_ms: Option<i64>) -> Option<TokenUsage> {
    if !valid_thread_id(thread_id) {
        return None;
    }
    let path = rollout_path(codex_home, thread_id)?;
    let file = fs::File::open(path).ok()?;
    let mut latest = None;
    let mut before = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Some(record) = serde_json::from_str::<Value>(&line).ok() else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        if record.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(totals) = record.pointer("/payload/info/total_token_usage") else {
            continue;
        };
        let usage = (|| {
            Some(TokenUsage {
                input_tokens: totals.get("input_tokens")?.as_u64()?,
                cached_input_tokens: totals.get("cached_input_tokens")?.as_u64()?,
                output_tokens: totals.get("output_tokens")?.as_u64()?,
                reasoning_output_tokens: totals.get("reasoning_output_tokens")?.as_u64()?,
                total_tokens: totals.get("total_tokens")?.as_u64()?,
            })
        })();
        if usage.is_none() {
            continue;
        }
        let at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|time| time.timestamp_millis());
        if since_ms.is_some_and(|since| at.is_some_and(|at| at < since)) {
            before = usage;
        }
        latest = usage;
    }
    let (latest, before) = (latest?, before.unwrap_or_default());
    Some(TokenUsage {
        input_tokens: latest.input_tokens.saturating_sub(before.input_tokens),
        cached_input_tokens: latest
            .cached_input_tokens
            .saturating_sub(before.cached_input_tokens),
        output_tokens: latest.output_tokens.saturating_sub(before.output_tokens),
        reasoning_output_tokens: latest
            .reasoning_output_tokens
            .saturating_sub(before.reasoning_output_tokens),
        total_tokens: latest.total_tokens.saturating_sub(before.total_tokens),
    })
}

/// Reads the thread's new steps from `offset`. Only complete lines are read.
pub fn read(codex_home: &Path, thread_id: &str, offset: u64) -> LogChunk {
    let missing = LogChunk {
        found: false,
        items: Vec::new(),
        offset,
    };
    if !valid_thread_id(thread_id) {
        return missing;
    }
    let Some(path) = rollout_path(codex_home, thread_id) else {
        return missing;
    };
    let Ok(mut file) = fs::File::open(&path) else {
        return missing;
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    // A file that shrank was replaced; start over.
    let start = if offset > length { 0 } else { offset };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return missing;
    }
    let mut bytes = Vec::new();
    let _ = file.take(MAX_READ_BYTES).read_to_end(&mut bytes);
    let complete = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);
    let items = String::from_utf8_lossy(&bytes[..complete])
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .flat_map(|record| parse_record(&record))
        .collect();
    LogChunk {
        found: true,
        items,
        offset: start + complete as u64,
    }
}

/// Codex thread IDs are UUIDs; anything else never reaches a path.
fn valid_thread_id(thread_id: &str) -> bool {
    !thread_id.is_empty()
        && thread_id.len() <= 64
        && thread_id
            .chars()
            .all(|character| character.is_ascii_hexdigit() || character == '-')
}

fn rollout_path(codex_home: &Path, thread_id: &str) -> Option<PathBuf> {
    static FOUND: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    let cache = FOUND.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(path) = cache
        .lock()
        .ok()?
        .get(thread_id)
        .filter(|path| path.is_file())
    {
        return Some(path.clone());
    }
    let path = find_rollout(&codex_home.join("sessions"), thread_id)?;
    cache
        .lock()
        .ok()?
        .insert(thread_id.to_string(), path.clone());
    Some(path)
}

/// The newest day folders first: `sessions/YYYY/MM/DD`.
fn find_rollout(sessions: &Path, thread_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{thread_id}.jsonl");
    let sorted_dirs = |dir: &Path| -> Vec<PathBuf> {
        let mut dirs = fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        dirs.sort();
        dirs.reverse();
        dirs
    };
    let days = sorted_dirs(sessions)
        .into_iter()
        .flat_map(|year| sorted_dirs(&year))
        .flat_map(|month| sorted_dirs(&month))
        .take(MAX_DAY_FOLDERS);
    for day in days {
        let found = fs::read_dir(&day)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(&suffix))
            });
        if found.is_some() {
            return found;
        }
    }
    None
}

fn shorten(text: &str) -> String {
    let text = text.trim_end();
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text.to_string();
    }
    let kept = text.chars().take(MAX_TEXT_CHARS).collect::<String>();
    format!("{kept}\n…")
}

/// The text parts of a content array, joined.
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// The command inside a tool call: Codex's `exec_command({cmd: "..."})`
/// script, a shell call's arguments, or the call as written.
fn command_text(name: &str, input: &str) -> String {
    if let Some(start) = input.find("cmd:") {
        let rest = input[start + 4..].trim_start();
        if let Some(quoted) = rest.strip_prefix('"') {
            let mut command = String::new();
            let mut escaped = false;
            for character in quoted.chars() {
                match (escaped, character) {
                    (true, 'n') => command.push('\n'),
                    (true, other) => command.push(other),
                    (false, '\\') => {
                        escaped = true;
                        continue;
                    }
                    (false, '"') => return command,
                    (false, other) => command.push(other),
                }
                escaped = false;
            }
        }
    }
    if let Ok(arguments) = serde_json::from_str::<Value>(input) {
        if let Some(command) = arguments.get("command") {
            return match command {
                Value::Array(parts) => parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "),
                other => other.as_str().unwrap_or_default().to_string(),
            };
        }
    }
    format!("{name}: {}", input.trim())
}

/// The files a patch touches, from its `*** Add/Update/Delete File:` lines.
fn patch_files(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| {
            ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix))
                .map(|path| path.trim().to_string())
        })
        .collect()
}

pub fn parse_record(record: &Value) -> Vec<LogItem> {
    let payload = record.get("payload").unwrap_or(&Value::Null);
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (record.get("type").and_then(Value::as_str), kind) {
        // The request as given; the user-role message also carries Codex's
        // own instructions and environment, which a terminal does not show.
        (Some("event_msg"), "item_completed") => {
            let item = payload.get("item").unwrap_or(&Value::Null);
            if item.get("type").and_then(Value::as_str) == Some("UserMessage") {
                let text = content_text(item.get("content"));
                if !text.trim().is_empty() {
                    return vec![LogItem::Task {
                        text: shorten(&text),
                    }];
                }
            }
            Vec::new()
        }
        (Some("response_item"), "message")
            if payload.get("role").and_then(Value::as_str) == Some("assistant") =>
        {
            let text = content_text(payload.get("content"));
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LogItem::Message {
                    text: shorten(&text),
                }]
            }
        }
        (Some("response_item"), "reasoning") => payload
            .get("summary")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .filter(|text| !text.trim().is_empty())
                    .map(|text| LogItem::Thinking {
                        text: shorten(text),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        (Some("response_item"), "custom_tool_call" | "function_call") => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let input = payload
                .get("input")
                .or_else(|| payload.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            // A patch may also come inside a script, its newlines escaped.
            let files = patch_files(&input.replace("\\n", "\n"));
            if name == "apply_patch" || !files.is_empty() {
                return vec![LogItem::Patch { files }];
            }
            vec![LogItem::Command {
                text: shorten(&command_text(name, input)),
            }]
        }
        (Some("response_item"), "custom_tool_call_output" | "function_call_output") => {
            let text = content_text(payload.get("output"));
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LogItem::Output {
                    text: shorten(&text),
                }]
            }
        }
        (Some("event_msg"), "task_complete") => vec![LogItem::Done {
            seconds: payload
                .get("duration_ms")
                .and_then(Value::as_f64)
                .map(|ms| (ms / 100.0).round() / 10.0),
        }],
        (Some("event_msg"), "turn_aborted") => vec![LogItem::Stopped],
        (Some("event_msg"), "token_count") => payload
            .pointer("/info/total_token_usage")
            .and_then(|usage| {
                let total = usage.get("total_tokens")?.as_u64()?;
                Some(vec![LogItem::Tokens {
                    total,
                    input_tokens: usage.get("input_tokens").and_then(Value::as_u64),
                    cached_input_tokens: usage.get("cached_input_tokens").and_then(Value::as_u64),
                    output_tokens: usage.get("output_tokens").and_then(Value::as_u64),
                    reasoning_output_tokens: usage
                        .get("reasoning_output_tokens")
                        .and_then(Value::as_u64),
                    total_tokens: total,
                }])
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Needs at least one Codex session on this computer. Run with
    /// `--ignored`; it only reads the newest session file.
    #[test]
    #[ignore]
    fn reads_the_newest_real_codex_session() {
        let home = crate::codex::codex_home().expect("codex home");
        let newest = fs::read_dir(home.join("sessions"))
            .expect("sessions")
            .flatten()
            .flat_map(|year| fs::read_dir(year.path()).into_iter().flatten().flatten())
            .flat_map(|month| fs::read_dir(month.path()).into_iter().flatten().flatten())
            .flat_map(|day| fs::read_dir(day.path()).into_iter().flatten().flatten())
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .max()
            .expect("a session file");
        let name = newest
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("name");
        let thread = &name[name.len() - 36..];
        let chunk = read(&home, thread, 0);
        assert!(chunk.found, "{thread}");
        assert!(chunk
            .items
            .iter()
            .any(|item| matches!(item, LogItem::Task { .. })));
        for item in &chunk.items {
            println!("{item:?}");
        }
    }

    #[test]
    fn turns_codex_records_into_the_steps_a_terminal_shows() {
        let records = [
            json!({ "type": "session_meta", "payload": { "id": "x" } }),
            json!({ "type": "response_item", "payload": { "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "hidden instructions" }] } }),
            json!({ "type": "response_item", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "# AGENTS.md instructions" }] } }),
            json!({ "type": "event_msg", "payload": { "type": "item_completed", "item": { "type": "UserMessage", "content": [{ "type": "text", "text": "Read note.txt and reply." }] } } }),
            json!({ "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "I'll read note.txt." }] } }),
            json!({ "type": "response_item", "payload": { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "Looking for the word" }], "encrypted_content": "zzz" } }),
            json!({ "type": "response_item", "payload": { "type": "custom_tool_call", "name": "exec", "input": "const r = await tools.exec_command({cmd:\"Get-Content -Raw -LiteralPath 'note.txt'\",\"max_output_tokens\":1000});\ntext(r.output);\n" } }),
            json!({ "type": "response_item", "payload": { "type": "custom_tool_call_output", "output": [{ "type": "input_text", "text": "Script completed\n" }, { "type": "input_text", "text": "The secret word is pineapple.\n" }] } }),
            json!({ "type": "response_item", "payload": { "type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: src/a.rs\n@@\n*** Add File: src/b.rs\n*** End Patch" } }),
            json!({ "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": { "total_tokens": 15713 } } } }),
            json!({ "type": "event_msg", "payload": { "type": "task_complete", "duration_ms": 14296 } }),
            json!({ "type": "event_msg", "payload": { "type": "turn_aborted" } }),
        ];
        let items = records.iter().flat_map(parse_record).collect::<Vec<_>>();
        assert_eq!(
            items,
            vec![
                LogItem::Task {
                    text: "Read note.txt and reply.".into()
                },
                LogItem::Message {
                    text: "I'll read note.txt.".into()
                },
                LogItem::Thinking {
                    text: "Looking for the word".into()
                },
                LogItem::Command {
                    text: "Get-Content -Raw -LiteralPath 'note.txt'".into()
                },
                LogItem::Output {
                    text: "Script completed\nThe secret word is pineapple.".into()
                },
                LogItem::Patch {
                    files: vec!["src/a.rs".into(), "src/b.rs".into()]
                },
                LogItem::Tokens {
                    total: 15713,
                    input_tokens: None,
                    cached_input_tokens: None,
                    output_tokens: None,
                    reasoning_output_tokens: None,
                    total_tokens: 15713,
                },
                LogItem::Done {
                    seconds: Some(14.3)
                },
                LogItem::Stopped,
            ]
        );
    }

    #[test]
    fn token_items_carry_codex_totals_and_omit_unknown_fields() {
        let record = |usage: Value| json!({ "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": usage } } });
        let totals = json!({
            "input_tokens": 110400, "cached_input_tokens": 98100,
            "output_tokens": 4200, "reasoning_output_tokens": 400, "total_tokens": 114600
        });
        let items = parse_record(&record(totals.clone()));
        assert_eq!(items.len(), 1);
        let mut expected = totals;
        expected["kind"] = json!("tokens");
        expected["total"] = json!(114600);
        assert_eq!(serde_json::to_value(&items[0]).expect("tokens"), expected);

        let legacy = parse_record(&record(json!({ "total_tokens": 1234 })));
        assert_eq!(
            serde_json::to_value(&legacy[0]).expect("legacy tokens"),
            json!({ "kind": "tokens", "total": 1234, "total_tokens": 1234 })
        );
        assert!(parse_record(&record(Value::Null)).is_empty());
    }

    #[test]
    fn reads_shell_calls_and_shortens_long_output() {
        let shell = json!({ "type": "response_item", "payload": { "type": "function_call", "name": "shell", "arguments": "{\"command\":[\"git\",\"status\"]}" } });
        assert_eq!(
            parse_record(&shell),
            vec![LogItem::Command {
                text: "git status".into()
            }]
        );
        let long = "x".repeat(MAX_TEXT_CHARS + 50);
        let output = json!({ "type": "response_item", "payload": { "type": "function_call_output", "output": long } });
        match &parse_record(&output)[0] {
            LogItem::Output { text } => assert_eq!(text.chars().count(), MAX_TEXT_CHARS + 2),
            other => panic!("{other:?}"),
        }
        assert_eq!(command_text("exec", "{\"cmd\": 1}"), "exec: {\"cmd\": 1}");
        let scripted = json!({ "type": "response_item", "payload": { "type": "custom_tool_call", "name": "exec", "input": "const patch = \"*** Begin Patch\\n*** Update File: cart.js\\n@@\\n*** End Patch\";" } });
        assert_eq!(
            parse_record(&scripted),
            vec![LogItem::Patch {
                files: vec!["cart.js".into()]
            }]
        );
    }

    #[test]
    fn follows_the_threads_file_from_an_offset_reading_whole_lines_only() {
        let home = std::env::temp_dir().join(format!("gswitch-tasklog-{}", uuid::Uuid::new_v4()));
        let day = home.join("sessions").join("2026").join("10").join("07");
        fs::create_dir_all(&day).expect("day");
        let thread = "01a11137-1469-7d20-8b79-d05abe3f3539";
        let file = day.join(format!("rollout-2026-10-07T01-02-03-{thread}.jsonl"));
        let message = |text: &str| {
            json!({ "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] } })
                .to_string()
        };
        fs::write(
            &file,
            format!("{}\n{}", message("first"), &message("second")[..20]),
        )
        .expect("write");

        let chunk = read(&home, thread, 0);
        assert!(chunk.found);
        assert_eq!(
            chunk.items,
            vec![LogItem::Message {
                text: "first".into()
            }]
        );
        // The half-written line is read once it is complete.
        fs::write(
            &file,
            format!("{}\n{}\n", message("first"), message("second")),
        )
        .expect("write");
        let next = read(&home, thread, chunk.offset);
        assert_eq!(
            next.items,
            vec![LogItem::Message {
                text: "second".into()
            }]
        );
        assert_eq!(read(&home, thread, next.offset).items, Vec::new());

        assert!(!read(&home, "01a11137-0000-0000-0000-000000000000", 0).found);
        assert!(!read(&home, "../../etc/passwd", 0).found);
        assert!(!read(&home, "", 0).found);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_resumed_thread_counts_only_the_tokens_used_since_the_task_started() {
        let home = std::env::temp_dir().join(format!("gswitch-usage-{}", uuid::Uuid::new_v4()));
        let day = home.join("sessions/2026/10/07");
        fs::create_dir_all(&day).expect("day");
        // Each fixture needs its own thread ID for the process-wide path cache.
        let thread = uuid::Uuid::new_v4().to_string();
        let count = |at: &str, total: u64| {
            json!({ "timestamp": at, "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": {
                "input_tokens": total, "cached_input_tokens": total / 2, "output_tokens": 10,
                "reasoning_output_tokens": 0, "total_tokens": total + 10 } } } })
            .to_string()
        };
        fs::write(
            day.join(format!("rollout-2026-10-07T01-02-03-{thread}.jsonl")),
            [
                count("2026-10-07T01:00:00Z", 1000),
                count("2026-10-07T02:00:00Z", 1600),
            ]
            .join("\n"),
        )
        .expect("rollout");
        let since = chrono::DateTime::parse_from_rfc3339("2026-10-07T01:30:00Z")
            .expect("time")
            .timestamp_millis();

        let resumed = usage(&home, &thread, Some(since)).expect("usage");
        assert_eq!(
            (resumed.input_tokens, resumed.cached_input_tokens),
            (600, 300)
        );
        assert_eq!((resumed.output_tokens, resumed.total_tokens), (0, 600));
        assert_eq!(
            usage(&home, &thread, None).expect("usage").total_tokens,
            1610
        );
        let _ = fs::remove_dir_all(home);
    }
}
