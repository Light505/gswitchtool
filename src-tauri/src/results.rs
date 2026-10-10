//! Read-only summary of routed coding results for the Results screen. It reads
//! the router plugin's `results.jsonl` and GSwitch's `codex-runs.jsonl`, never
//! writes, and returns counts and medians without titles, project paths,
//! session, agent or job identifiers.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;

/// Only the newest part of each log is read.
const MAX_READ_BYTES: u64 = 20 * 1024 * 1024;
const DAY_MS: i64 = 86_400_000;
const DIFFICULTIES: [&str; 5] = ["trivial", "small", "moderate", "hard", "high-risk"];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const OUTCOMES: [&str; 4] = ["pass", "fail", "unverified", "blocked"];

/// USD per million tokens (docs/model-benchmarks.md, Prices).
#[derive(Clone, Copy)]
struct Price {
    input: f64,
    cached_input: f64,
    output: f64,
}

const SOL: Price = Price {
    input: 2.0,
    cached_input: 0.10,
    output: 10.0,
};
const SOL_LONG: Price = Price {
    input: 4.0,
    cached_input: 0.20,
    output: 15.0,
};
const LUNA: Price = Price {
    input: 0.10,
    cached_input: 0.01,
    output: 0.50,
};
const LUNA_LONG: Price = Price {
    input: 0.20,
    cached_input: 0.02,
    output: 0.75,
};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultsSummary {
    pub since: String,
    pub tasks: u64,
    pub rows: Vec<ResultsRow>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultsRow {
    pub worker: String,
    pub family: &'static str,
    pub model: String,
    pub effort: String,
    pub difficulty: String,
    pub attempts: u64,
    pub passes: u64,
    pub first_tries: u64,
    pub first_try_passes: u64,
    pub samples: u64,
    pub median_ms: Option<f64>,
    pub median_tokens: Option<f64>,
    pub median_usd: Option<f64>,
}

/// The router plugin's results log for this build identity.
pub fn router_results_path(home: &Path, dev: bool) -> PathBuf {
    home.join(if dev {
        ".gswitchtool-router-dev"
    } else {
        ".gswitchtool-router"
    })
    .join("results.jsonl")
}

struct Worker {
    family: &'static str,
    model: String,
    effort: String,
}

/// `router:<model>-<effort>` or `codex:<model>/<effort>` (and their `-dev` namespaces).
fn parse_worker(worker: &str) -> Option<Worker> {
    let (namespace, rest) = worker.split_once(':')?;
    let (family, model, effort) = match namespace {
        "router" | "router-dev" => {
            let (model, effort) = rest.split_once('-')?;
            if !matches!(model, "haiku" | "sonnet" | "opus") {
                return None;
            }
            ("claude", model, effort)
        }
        "codex" | "codex-dev" => {
            let (model, effort) = rest.split_once('/')?;
            let valid = model.starts_with(|c: char| c.is_ascii_alphanumeric())
                && model
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
            if !valid {
                return None;
            }
            ("codex", model, effort)
        }
        _ => return None,
    };
    EFFORTS.contains(&effort).then(|| Worker {
        family,
        model: model.to_string(),
        effort: effort.to_string(),
    })
}

/// JSON objects from the last `limit` bytes; corrupt or partial lines are skipped.
fn read_records(path: &Path, limit: u64) -> Vec<Value> {
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let start = length.saturating_sub(limit);
    // Start one byte early so the first, dropped line is never a whole record.
    let from = start.saturating_sub(1);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(from)).is_err()
        || file.take(limit + 1).read_to_end(&mut bytes).is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 {
        lines.next();
    }
    lines
        .filter_map(|line| serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')).ok())
        .filter(Value::is_object)
        .collect()
}

fn text<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    record
        .get(key)?
        .as_str()
        .filter(|value| !value.trim().is_empty() && !value.chars().any(char::is_control))
}

fn number(record: &Value, key: &str) -> Option<f64> {
    record
        .get(key)?
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

#[derive(Clone, Copy, Default)]
struct Telemetry {
    ms: Option<f64>,
    tokens: Option<f64>,
    usd: Option<f64>,
}

#[derive(Clone, Copy, Default)]
struct Tokens {
    input: u64,
    cached_input: u64,
    output: u64,
}

fn tokens(value: &Value) -> Option<Tokens> {
    Some(Tokens {
        input: value.get("input")?.as_u64()?,
        cached_input: value.get("cachedInput")?.as_u64()?,
        output: value.get("output")?.as_u64()?,
    })
}

/// OpenAI usage counts cached input inside input and reasoning inside output.
fn cost(tokens: Tokens, price: Price) -> f64 {
    let cached = tokens.cached_input.min(tokens.input);
    (tokens.input - cached) as f64 * price.input
        + cached as f64 * price.cached_input
        + tokens.output as f64 * price.output
}

/// A Codex run's API list price; long-prompt turns use the > 272K row.
fn codex_usd(run: &Value) -> Option<f64> {
    let (normal, long_price) = match run.get("model")?.as_str()? {
        "gpt-6.1-sol" => (SOL, SOL_LONG),
        "gpt-6-luna" => (LUNA, LUNA_LONG),
        _ => return None,
    };
    let all = tokens(run.get("tokenBreakdown")?)?;
    let long = run
        .get("longPromptTokens")
        .and_then(tokens)
        .unwrap_or_default();
    let rest = Tokens {
        input: all.input.saturating_sub(long.input),
        cached_input: all.cached_input.saturating_sub(long.cached_input),
        output: all.output.saturating_sub(long.output),
    };
    Some((cost(rest, normal) + cost(long, long_price)) / 1_000_000.0)
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    })
}

#[derive(Default)]
struct Group {
    attempts: u64,
    passes: u64,
    first_tries: u64,
    first_try_passes: u64,
    samples: u64,
    ms: Vec<f64>,
    tokens: Vec<f64>,
    usd: Vec<f64>,
}

struct Counted<'a> {
    time: i64,
    session: &'a str,
    task: &'a str,
    worker: &'a str,
    difficulty: usize,
    pass: bool,
    sample: bool,
    telemetry: Telemetry,
}

pub fn summarize(results: &Path, codex_runs: &Path, days: u32, now_ms: i64) -> ResultsSummary {
    summarize_limited(results, codex_runs, days, now_ms, MAX_READ_BYTES)
}

fn summarize_limited(
    results: &Path,
    codex_runs: &Path,
    days: u32,
    now_ms: i64,
    limit: u64,
) -> ResultsSummary {
    let since_ms = now_ms - i64::from(days.clamp(1, 365)) * DAY_MS;
    let records = read_records(results, limit);
    let runs = read_records(codex_runs, limit);

    // A worker's attempt records are cumulative: the latest value of each field wins.
    let mut attempts: HashMap<(&str, &str), Telemetry> = HashMap::new();
    for record in records
        .iter()
        .filter(|r| text(r, "type") == Some("attempt"))
    {
        let (Some(session), Some(agent)) = (text(record, "sessionId"), text(record, "agentId"))
        else {
            continue;
        };
        let entry = attempts.entry((session, agent)).or_default();
        entry.ms = number(record, "durationMs").or(entry.ms);
        entry.tokens = number(record, "tokens").or(entry.tokens);
        entry.usd = number(record, "usd").or(entry.usd);
    }
    let jobs: HashMap<&str, Telemetry> = runs
        .iter()
        .filter_map(|run| {
            Some((
                text(run, "jobId")?,
                Telemetry {
                    ms: number(run, "totalMs"),
                    tokens: number(run, "tokens"),
                    usd: codex_usd(run),
                },
            ))
        })
        .collect();

    let mut counted = Vec::new();
    let mut workers: HashMap<&str, Worker> = HashMap::new();
    for record in &records {
        if text(record, "type") != Some("result") {
            continue;
        }
        let (Some(session), Some(task), Some(worker), Some(outcome)) = (
            text(record, "sessionId"),
            text(record, "task"),
            text(record, "worker"),
            text(record, "outcome"),
        ) else {
            continue;
        };
        let Some(difficulty) = text(record, "difficulty")
            .and_then(|value| DIFFICULTIES.iter().position(|known| *known == value))
        else {
            continue;
        };
        let Some(time) = text(record, "time")
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
        else {
            continue;
        };
        if worker == "orchestrator"
            || outcome == "blocked"
            || !OUTCOMES.contains(&outcome)
            || time < since_ms
        {
            continue;
        }
        if !workers.contains_key(worker) {
            let Some(parsed) = parse_worker(worker) else {
                continue;
            };
            workers.insert(worker, parsed);
        }
        let telemetry = if workers[worker].family == "codex" {
            text(record, "codexJobId").and_then(|job| jobs.get(job).copied())
        } else {
            text(record, "agentId").and_then(|agent| attempts.get(&(session, agent)).copied())
        };
        counted.push(Counted {
            time,
            session,
            task,
            worker,
            difficulty,
            pass: matches!(outcome, "pass" | "unverified"),
            sample: record.get("sample") == Some(&Value::Bool(true)),
            telemetry: telemetry.unwrap_or_default(),
        });
    }
    counted.sort_by_key(|result| result.time);

    let mut tasks = HashSet::new();
    let mut groups: BTreeMap<(&str, usize), Group> = BTreeMap::new();
    for result in &counted {
        let first = tasks.insert((result.session, result.task));
        let group = groups
            .entry((result.worker, result.difficulty))
            .or_default();
        group.attempts += 1;
        group.passes += u64::from(result.pass);
        group.samples += u64::from(result.sample);
        if first {
            group.first_tries += 1;
            group.first_try_passes += u64::from(result.pass);
        }
        group.ms.extend(result.telemetry.ms);
        group.tokens.extend(result.telemetry.tokens);
        group.usd.extend(result.telemetry.usd);
    }

    ResultsSummary {
        since: chrono::DateTime::from_timestamp_millis(since_ms)
            .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default(),
        tasks: tasks.len() as u64,
        rows: groups
            .into_iter()
            .map(|((worker, difficulty), group)| {
                let parsed = &workers[worker];
                ResultsRow {
                    worker: worker.to_string(),
                    family: parsed.family,
                    model: parsed.model.clone(),
                    effort: parsed.effort.clone(),
                    difficulty: DIFFICULTIES[difficulty].to_string(),
                    attempts: group.attempts,
                    passes: group.passes,
                    first_tries: group.first_tries,
                    first_try_passes: group.first_try_passes,
                    samples: group.samples,
                    median_ms: median(group.ms),
                    median_tokens: median(group.tokens),
                    median_usd: median(group.usd),
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: &str = "2026-10-10T12:00:00.000Z";

    fn now_ms() -> i64 {
        chrono::DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .timestamp_millis()
    }

    fn ago(days: f64) -> String {
        chrono::DateTime::from_timestamp_millis(now_ms() - (days * DAY_MS as f64) as i64)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn result(days: f64, session: &str, task: &str, worker: &str, outcome: &str) -> Value {
        json!({
            "type": "result", "time": ago(days), "sessionId": session, "project": "c:/work/secret-project",
            "task": task, "difficulty": "small", "worker": worker, "outcome": outcome,
            "reason": if outcome == "fail" { Value::from("verify") } else { Value::Null },
            "step": "start", "title": "Secret title", "agentId": null, "codexJobId": null
        })
    }

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(results: &[Value], runs: &[Value]) -> Self {
            let dir =
                std::env::temp_dir().join(format!("gswitch-results-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let lines = |values: &[Value]| {
                values
                    .iter()
                    .map(|value| format!("{value}\n"))
                    .collect::<String>()
            };
            fs::write(dir.join("results.jsonl"), lines(results)).unwrap();
            fs::write(dir.join("codex-runs.jsonl"), lines(runs)).unwrap();
            Self { dir }
        }

        fn summary(&self, days: u32) -> ResultsSummary {
            summarize(
                &self.dir.join("results.jsonl"),
                &self.dir.join("codex-runs.jsonl"),
                days,
                now_ms(),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn row<'a>(summary: &'a ResultsSummary, worker: &str) -> &'a ResultsRow {
        summary
            .rows
            .iter()
            .find(|row| row.worker == worker)
            .unwrap()
    }

    fn sol_run(job: &str, model: &str, long: Option<Value>) -> Value {
        json!({
            "version": 1, "time": ago(1.0), "jobId": job, "threadId": "thread-secret", "model": model,
            "effort": "medium", "totalMs": 60000, "tokens": 1100000,
            "tokenBreakdown": { "input": 1000000, "cachedInput": 400000, "output": 100000, "reasoningOutput": 30000 },
            "longPromptTokens": long
        })
    }

    #[test]
    fn results_missing_files_give_empty_rows() {
        let dir =
            std::env::temp_dir().join(format!("gswitch-results-missing-{}", uuid::Uuid::new_v4()));
        let summary = summarize(
            &dir.join("results.jsonl"),
            &dir.join("codex-runs.jsonl"),
            30,
            now_ms(),
        );
        assert_eq!(summary.tasks, 0);
        assert!(summary.rows.is_empty());
        assert!(!dir.exists());
    }

    #[test]
    fn results_window_counts_recent_results_and_clamps_days() {
        let fixture = Fixture::new(
            &[
                result(2.0, "s1", "t1", "router:haiku-low", "pass"),
                result(10.0, "s1", "t2", "router:haiku-low", "pass"),
                result(400.0, "s1", "t3", "router:haiku-low", "pass"),
            ],
            &[],
        );
        let week = fixture.summary(7);
        assert_eq!(week.since, ago(7.0));
        assert_eq!(
            (week.tasks, row(&week, "router:haiku-low").attempts),
            (1, 1)
        );
        assert_eq!(row(&fixture.summary(30), "router:haiku-low").attempts, 2);
        assert_eq!(fixture.summary(0).since, ago(1.0));
        let year = fixture.summary(1000);
        assert_eq!(year.since, ago(365.0));
        assert_eq!(row(&year, "router:haiku-low").attempts, 2);
    }

    #[test]
    fn results_skip_blocked_orchestrator_and_unknown_workers() {
        let mut bad_difficulty = result(1.0, "s1", "t5", "router:haiku-low", "pass");
        bad_difficulty["difficulty"] = json!("epic");
        let fixture = Fixture::new(
            &[
                result(1.0, "s1", "t1", "router:sonnet-medium", "blocked"),
                result(1.0, "s1", "t2", "orchestrator", "pass"),
                result(1.0, "s1", "t3", "router:gpt-low", "pass"),
                result(1.0, "s1", "t4", "codex:gpt-6.1-sol/turbo", "pass"),
                bad_difficulty,
                result(1.0, "s1", "t6", "router-dev:opus-max", "unverified"),
                result(1.0, "s1", "t7", "codex-dev:gpt-6.1-sol/xhigh", "fail"),
            ],
            &[],
        );
        let summary = fixture.summary(30);
        assert_eq!(summary.tasks, 2);
        assert_eq!(summary.rows.len(), 2);
        let opus = row(&summary, "router-dev:opus-max");
        assert_eq!(
            (opus.family, opus.model.as_str(), opus.effort.as_str()),
            ("claude", "opus", "max")
        );
        assert_eq!((opus.attempts, opus.passes), (1, 1));
        let sol = row(&summary, "codex-dev:gpt-6.1-sol/xhigh");
        assert_eq!(
            (sol.family, sol.model.as_str(), sol.effort.as_str()),
            ("codex", "gpt-6.1-sol", "xhigh")
        );
        assert_eq!((sol.attempts, sol.passes), (1, 0));
    }

    #[test]
    fn results_first_try_is_the_earliest_counted_result_per_task() {
        let mut sample = result(1.0, "s1", "t1", "router:sonnet-medium", "pass");
        sample["sample"] = json!(true);
        let fixture = Fixture::new(
            &[
                // Written out of time order on purpose.
                sample,
                result(3.0, "s1", "t1", "router:haiku-low", "fail"),
                result(4.0, "s1", "t1", "router:opus-high", "blocked"),
                result(2.0, "s2", "t1", "router:sonnet-medium", "pass"),
            ],
            &[],
        );
        let summary = fixture.summary(30);
        assert_eq!(summary.tasks, 2);
        let haiku = row(&summary, "router:haiku-low");
        assert_eq!(
            (haiku.first_tries, haiku.first_try_passes, haiku.passes),
            (1, 0, 0)
        );
        let sonnet = row(&summary, "router:sonnet-medium");
        assert_eq!(
            (
                sonnet.attempts,
                sonnet.passes,
                sonnet.first_tries,
                sonnet.first_try_passes,
                sonnet.samples
            ),
            (2, 2, 1, 1, 1)
        );
    }

    #[test]
    fn results_claude_telemetry_uses_the_latest_attempt_values() {
        let mut first = result(1.0, "s1", "t1", "router:haiku-low", "pass");
        first["agentId"] = json!("agent-a");
        let mut second = result(1.0, "s1", "t2", "router:haiku-low", "pass");
        second["agentId"] = json!("agent-b");
        let mut other_session = result(1.0, "s2", "t3", "router:haiku-low", "pass");
        other_session["agentId"] = json!("agent-a");
        let attempt = |session: &str, agent: &str, ms: Value, tokens: Value, usd: Value| {
            json!({ "type": "attempt", "time": ago(1.0), "sessionId": session, "agentId": agent,
                "worker": "router:haiku-low", "durationMs": ms, "tokens": tokens, "usd": usd })
        };
        let fixture = Fixture::new(
            &[
                attempt("s1", "agent-a", json!(1000), json!(10), json!(0.5)),
                attempt("s1", "agent-a", json!(3000), json!(30), Value::Null),
                attempt("s1", "agent-b", json!(5000), json!(50), json!(1.5)),
                first,
                second,
                other_session,
            ],
            &[],
        );
        let haiku = row(&fixture.summary(30), "router:haiku-low").telemetry();
        assert_eq!(haiku, (3, Some(4000.0), Some(40.0), Some(1.0)));
    }

    impl ResultsRow {
        fn telemetry(&self) -> (u64, Option<f64>, Option<f64>, Option<f64>) {
            (
                self.attempts,
                self.median_ms,
                self.median_tokens,
                self.median_usd,
            )
        }
    }

    #[test]
    fn results_codex_telemetry_joins_runs_by_job_id_and_prices_tokens() {
        let codex = |task: &str, worker: &str, job: &str| {
            let mut record = result(1.0, "s1", task, worker, "pass");
            record["codexJobId"] = json!(job);
            record
        };
        let long = json!({ "input": 500000, "cachedInput": 200000, "output": 50000, "reasoningOutput": 10000 });
        let fixture = Fixture::new(
            &[
                codex("t1", "codex:gpt-6.1-sol/medium", "job-plain"),
                codex("t2", "codex:gpt-6.1-sol/high", "job-long"),
                codex("t3", "codex:gpt-6-luna/low", "job-luna"),
                codex("t4", "codex:gpt-5.5/low", "job-other"),
                codex("t5", "codex:gpt-6.1-sol/xhigh", "job-missing"),
            ],
            &[
                sol_run("job-plain", "gpt-6.1-sol", None),
                sol_run("job-long", "gpt-6.1-sol", Some(long)),
                sol_run("job-luna", "gpt-6-luna", None),
                sol_run("job-other", "gpt-5.5", None),
            ],
        );
        let summary = fixture.summary(30);
        let close = |value: Option<f64>, expected: f64| {
            assert!(
                (value.unwrap() - expected).abs() < 1e-9,
                "{value:?} != {expected}"
            )
        };
        let plain = row(&summary, "codex:gpt-6.1-sol/medium");
        assert_eq!(
            (plain.median_ms, plain.median_tokens),
            (Some(60000.0), Some(1100000.0))
        );
        // 600K input at 2.00, 400K cached at 0.10, 100K output at 10.00.
        close(plain.median_usd, 2.24);
        // Normal part 1.12 plus long part 300K at 4.00, 200K at 0.20, 50K at 15.00.
        close(row(&summary, "codex:gpt-6.1-sol/high").median_usd, 3.11);
        close(
            row(&summary, "codex:gpt-6-luna/low").median_usd,
            0.06 + 0.004 + 0.05,
        );
        let other = row(&summary, "codex:gpt-5.5/low");
        assert_eq!((other.median_ms, other.median_usd), (Some(60000.0), None));
        let missing = row(&summary, "codex:gpt-6.1-sol/xhigh");
        assert_eq!(missing.telemetry(), (1, None, None, None));
    }

    #[test]
    fn results_skip_corrupt_lines() {
        let fixture = Fixture::new(&[result(1.0, "s1", "t1", "router:haiku-low", "pass")], &[]);
        let path = fixture.dir.join("results.jsonl");
        let valid = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            format!("\u{feff}not json\n[1,2]\n{valid}{{\"type\":\"result\",\"time\"\r\n{valid}"),
        )
        .unwrap();
        let summary = fixture.summary(30);
        assert_eq!(row(&summary, "router:haiku-low").attempts, 2);
    }

    #[test]
    fn results_read_only_the_newest_bytes() {
        let older = result(1.0, "s1", "t1", "router:haiku-low", "pass");
        let newer = result(1.0, "s1", "t2", "router:sonnet-low", "pass");
        let fixture = Fixture::new(&[older, newer.clone()], &[]);
        let limit = format!("{newer}\n").len() as u64;
        let summary = summarize_limited(
            &fixture.dir.join("results.jsonl"),
            &fixture.dir.join("codex-runs.jsonl"),
            30,
            now_ms(),
            limit,
        );
        assert_eq!(summary.rows.len(), 1);
        assert_eq!(summary.rows[0].worker, "router:sonnet-low");
        // A limit that cuts the newest record skips it rather than misreading it.
        let cut = summarize_limited(
            &fixture.dir.join("results.jsonl"),
            &fixture.dir.join("codex-runs.jsonl"),
            30,
            now_ms(),
            limit - 1,
        );
        assert!(cut.rows.is_empty());
    }

    #[test]
    fn results_output_has_no_identifiers_or_paths() {
        let mut claude = result(
            1.0,
            "session-secret",
            "task-secret",
            "router:haiku-low",
            "pass",
        );
        claude["agentId"] = json!("agent-secret");
        let mut codex = result(
            1.0,
            "session-secret",
            "task-other",
            "codex:gpt-6.1-sol/medium",
            "pass",
        );
        codex["codexJobId"] = json!("job-secret");
        codex["codexThreadId"] = json!("thread-secret");
        let fixture = Fixture::new(
            &[
                json!({ "type": "plan", "time": ago(1.0), "sessionId": "session-secret", "project": "c:/work/secret-project",
                    "task": "task-secret", "difficulty": "small", "title": "Secret title" }),
                claude,
                codex,
            ],
            &[sol_run("job-secret", "gpt-6.1-sol", None)],
        );
        let summary = fixture.summary(30);
        assert_eq!(summary.rows.len(), 2);
        let output = serde_json::to_string(&summary).unwrap();
        for secret in [
            "secret",
            "Secret",
            "c:/work",
            "s1",
            fixture.dir.to_string_lossy().as_ref(),
        ] {
            assert!(!output.contains(secret), "{secret} leaked: {output}");
        }
    }
}
