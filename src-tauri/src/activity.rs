//! Invoke Mode activity history (added by Light505 for gswitchtool): what
//! GSwitch did and why, kept as JSON lines in the data folder. Entries name
//! saved accounts by ID and Codex work by model, folder, and thread; they never
//! hold credentials, prompts, or Codex output.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::failover::SwitchReason;

/// The log keeps at most this many entries; older ones are dropped.
const KEEP: usize = 1000;
/// It is trimmed back to `KEEP` once it grows this long.
const TRIM_AT: usize = 1200;

/// One thing Invoke Mode did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Activity {
    TaskStarted {
        task: String,
        model: String,
        effort: String,
        write: bool,
        cwd: String,
    },
    TaskEnded {
        task: String,
        model: String,
        thread_id: Option<String>,
        /// The plugin's result: completed, failed, rejected, or unknown.
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    TaskStopped {
        task: String,
        model: String,
        thread_id: Option<String>,
    },
    Switched {
        from: String,
        to: String,
        reason: SwitchReason,
    },
    Paused {
        resumes_at: Option<i64>,
        threads: Vec<String>,
    },
    Resumed {
        by_user: bool,
        threads: Vec<String>,
    },
    Woke {
        accounts: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEntry {
    /// Unix milliseconds.
    pub at: i64,
    #[serde(flatten)]
    pub activity: Activity,
}

/// Called with each new entry, for the window.
pub type RecordedCallback = Box<dyn Fn(&ActivityEntry) + Send + Sync>;

pub struct ActivityLog {
    path: PathBuf,
    lock: Mutex<()>,
    on_record: Option<RecordedCallback>,
}

impl ActivityLog {
    pub fn new(path: PathBuf, on_record: Option<RecordedCallback>) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            on_record,
        }
    }

    /// Appends an entry. A log that cannot be written never stops the work it
    /// describes.
    pub fn record(&self, activity: Activity) {
        let entry = ActivityEntry {
            at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or_default(),
            activity,
        };
        if let Ok(_guard) = self.lock.lock() {
            if let Ok(line) = serde_json::to_string(&entry) {
                if let Ok(mut file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                {
                    let _ = writeln!(file, "{line}");
                }
            }
            self.trim();
        }
        if let Some(callback) = &self.on_record {
            callback(&entry);
        }
    }

    /// The newest entries, newest first. Unreadable lines are skipped.
    pub fn recent(&self, limit: usize) -> Vec<ActivityEntry> {
        let _guard = self.lock.lock();
        let content = fs::read_to_string(&self.path).unwrap_or_default();
        content
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str(line).ok())
            .take(limit)
            .collect()
    }

    fn trim(&self) {
        let Ok(content) = fs::read_to_string(&self.path) else {
            return;
        };
        let lines = content.lines().collect::<Vec<_>>();
        if lines.len() < TRIM_AT {
            return;
        }
        let kept = lines[lines.len() - KEEP..].join("\n") + "\n";
        let temporary = self.path.with_extension("jsonl.tmp");
        if fs::write(&temporary, kept).is_ok() {
            let _ = fs::rename(&temporary, &self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log() -> (ActivityLog, PathBuf) {
        let dir = std::env::temp_dir().join(format!("gswitch-activity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("dir");
        (ActivityLog::new(dir.join("activity.jsonl"), None), dir)
    }

    #[test]
    fn records_newest_first_and_skips_damaged_lines() {
        let (log, dir) = temp_log();
        log.record(Activity::Woke {
            accounts: vec!["a".into()],
        });
        fs::write(
            dir.join("activity.jsonl"),
            fs::read_to_string(dir.join("activity.jsonl")).expect("read") + "not json\n",
        )
        .expect("write");
        log.record(Activity::Switched {
            from: "a".into(),
            to: "b".into(),
            reason: SwitchReason::Priority,
        });
        let recent = log.recent(10);
        assert_eq!(recent.len(), 2);
        assert!(matches!(recent[0].activity, Activity::Switched { .. }));
        assert!(matches!(recent[1].activity, Activity::Woke { .. }));
        assert_eq!(log.recent(1).len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_only_the_latest_entries() {
        let (log, dir) = temp_log();
        for index in 0..TRIM_AT {
            log.record(Activity::Woke {
                accounts: vec![index.to_string()],
            });
        }
        let lines = fs::read_to_string(dir.join("activity.jsonl"))
            .expect("read")
            .lines()
            .count();
        assert_eq!(lines, KEEP);
        let newest = &log.recent(1)[0];
        assert_eq!(
            newest.activity,
            Activity::Woke {
                accounts: vec![(TRIM_AT - 1).to_string()]
            }
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn entries_hold_plain_fields_with_a_kind() {
        let entry = ActivityEntry {
            at: 5,
            activity: Activity::TaskEnded {
                task: "t".into(),
                model: "m".into(),
                thread_id: None,
                status: "completed".into(),
                code: None,
            },
        };
        assert_eq!(
            serde_json::to_value(&entry).expect("json"),
            serde_json::json!({ "at": 5, "kind": "task_ended", "task": "t", "model": "m", "thread_id": null, "status": "completed" })
        );
    }
}
