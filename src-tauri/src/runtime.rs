use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const QUIT_CODEX: &str = "Quit Codex before changing the active account";
const DAEMON_STOP_TIMEOUT: Duration = Duration::from_secs(15);
const DAEMON_EXIT_TIMEOUT: Duration = Duration::from_secs(10);

const BROKER_REPLY_TIMEOUT: Duration = Duration::from_secs(2);

/// What Codex is running outside GSwitch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CodexPresence {
    /// A Codex the user opened: the app, the CLI, or an IDE extension, or a
    /// Claude Code plugin broker that is busy or did not answer.
    open: bool,
    /// Codex's managed App Server daemon, which has no window and keeps
    /// running after the user closes Codex.
    background: bool,
    /// Claude Code plugin brokers with no request running.
    idle_brokers: Vec<Broker>,
    /// Whether any broker process was seen, when brokers were not asked.
    brokers_present: bool,
}

/// The Claude Code plugin's shared App Server for OpenAI's stock `/codex`
/// commands (`app-server-broker.mjs serve`), which outlives those commands.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Broker {
    pid: u32,
    endpoint: String,
}

/// Detects only known Codex command lines. A Codex the user opened must be
/// closed by the user; Codex's windowless daemon is stopped here through its
/// official command, because it would otherwise keep the old credential. The
/// caller must still perform a second preflight immediately before changing
/// the live auth file because a process can start after this snapshot.
pub fn ensure_no_external_codex(excluded_pids: &[u32]) -> Result<(), String> {
    let presence = codex_presence(excluded_pids, true)?;
    if presence.open {
        return Err(QUIT_CODEX.to_string());
    }
    if presence.background || !presence.idle_brokers.is_empty() {
        stop_background_codex(excluded_pids, &presence)?;
    }
    Ok(())
}

/// Returns whether a known external Codex runtime is active, including the
/// windowless daemon, which can also refresh credentials. An uninspectable
/// Node process remains an error rather than being mistaken for a safe
/// absence. Wake uses this to skip only an account that matches the
/// externally active identity.
pub fn external_codex_running(excluded_pids: &[u32]) -> Result<bool, String> {
    let presence = codex_presence(excluded_pids, true)?;
    Ok(presence.open || presence.background || !presence.idle_brokers.is_empty())
}

/// Returns whether a Codex the user opened is running. The windowless daemon
/// does not count: `ensure_no_external_codex` stops it before a switch.
pub fn user_codex_open(excluded_pids: &[u32]) -> Result<bool, String> {
    Ok(codex_presence(excluded_pids, true)?.open)
}

/// Stops Codex's managed App Server daemon with `codex app-server daemon stop`
/// and idle plugin brokers with their own `broker/shutdown`, then waits until
/// they have exited. Codex and the plugin start them again when needed.
fn stop_background_codex(excluded_pids: &[u32], presence: &CodexPresence) -> Result<(), String> {
    for broker in &presence.idle_brokers {
        let _ = broker_request(&broker.endpoint, "broker/shutdown");
    }
    if presence.background {
        stop_daemon();
    }
    let deadline = Instant::now() + DAEMON_EXIT_TIMEOUT;
    loop {
        let now = codex_presence(excluded_pids, false)?;
        let remaining = now.background || now.brokers_present;
        if now.open || (remaining && Instant::now() >= deadline) {
            return Err(QUIT_CODEX.to_string());
        }
        if !remaining {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn stop_daemon() {
    let mut command = crate::app_server::codex_command();
    command
        .args(["app-server", "daemon", "stop"])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let deadline = Instant::now() + DAEMON_STOP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
}

/// Starts a console program without flashing a console window.
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

/// Sends one request to a plugin broker and returns its result. A broker that
/// does not answer in time, or answers with an error, gives `None`.
fn broker_request(endpoint: &str, method: &str) -> Option<serde_json::Value> {
    let endpoint = endpoint.to_string();
    let request = format!(
        "{}\n",
        serde_json::json!({ "id": 1, "method": method, "params": {} })
    );
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(broker_exchange(&endpoint, &request));
    });
    let reply = receiver.recv_timeout(BROKER_REPLY_TIMEOUT).ok().flatten()?;
    serde_json::from_str::<serde_json::Value>(&reply)
        .ok()?
        .get("result")
        .cloned()
}

#[cfg(windows)]
fn broker_exchange(endpoint: &str, request: &str) -> Option<String> {
    let path = endpoint.strip_prefix("pipe:")?;
    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .ok()?;
    pipe.write_all(request.as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(pipe).read_line(&mut line).ok()?;
    Some(line)
}

#[cfg(unix)]
fn broker_exchange(endpoint: &str, request: &str) -> Option<String> {
    let path = endpoint.strip_prefix("unix:")?;
    let mut socket = std::os::unix::net::UnixStream::connect(path).ok()?;
    socket.write_all(request.as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(socket).read_line(&mut line).ok()?;
    Some(line)
}

/// The control endpoint of a plugin broker, from its command line.
fn broker_endpoint(command: &[OsString]) -> Option<String> {
    let parts = command
        .iter()
        .map(|part| part.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let is_broker = parts.iter().any(|part| {
        part.replace('\\', "/")
            .to_ascii_lowercase()
            .ends_with("/app-server-broker.mjs")
    }) && parts.iter().any(|part| part == "serve");
    if !is_broker {
        return None;
    }
    let index = parts.iter().position(|part| part == "--endpoint")?;
    parts
        .get(index + 1)
        .filter(|value| !value.is_empty())
        .cloned()
}

/// Scans running processes. With `ask_brokers`, each plugin broker is asked
/// whether it is busy; otherwise brokers are only noted as present.
fn codex_presence(excluded_pids: &[u32], ask_brokers: bool) -> Result<CodexPresence, String> {
    // Dev owns a separate CODEX_HOME. Process command lines do not reliably
    // identify which home a Codex process opened, so Dev must never stop or
    // wait for the user's default-home Codex or the installed app's workers.
    if crate::build_identity::is_dev_identifier(
        &std::env::var("GSWITCH_APP_IDENTIFIER").unwrap_or_default(),
    ) {
        return Ok(CodexPresence::default());
    }
    let mut excluded = excluded_pids.iter().copied().collect::<HashSet<_>>();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::Always)
            .without_tasks(),
    );
    extend_published_worker_pids(&mut excluded, &published_worker_files(), |pid| {
        system.process(sysinfo::Pid::from_u32(pid)).is_some()
    });

    // On Windows GSwitch launches `cmd -> codex.cmd -> node`. Excluding only
    // the direct child would make our own App Server look external; expand the
    // explicit roots to their descendants from this one process snapshot.
    loop {
        let descendants = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                process
                    .parent()
                    .map(|parent| (pid.as_u32(), parent.as_u32()))
            })
            .filter_map(|(pid, parent)| excluded.contains(&parent).then_some(pid))
            .collect::<Vec<_>>();
        let before = excluded.len();
        excluded.extend(descendants);
        if excluded.len() == before {
            break;
        }
    }

    let brokers = system
        .processes()
        .iter()
        .filter(|(pid, _)| !excluded.contains(&pid.as_u32()))
        .filter_map(|(pid, process)| {
            broker_endpoint(process.cmd()).map(|endpoint| Broker {
                pid: pid.as_u32(),
                endpoint,
            })
        })
        .collect::<Vec<_>>();
    let parents = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            process
                .parent()
                .map(|parent| (pid.as_u32(), parent.as_u32()))
        })
        .collect::<HashMap<_, _>>();
    let under_broker = |pid: u32| {
        let mut current = pid;
        for _ in 0..12 {
            match parents.get(&current) {
                Some(parent) if brokers.iter().any(|broker| broker.pid == *parent) => return true,
                Some(parent) => current = *parent,
                None => return false,
            }
        }
        false
    };

    let mut presence = CodexPresence::default();
    for (pid, process) in system.processes() {
        let pid = pid.as_u32();
        if pid == std::process::id()
            || excluded.contains(&pid)
            || !is_codex_process(process.name(), process.cmd())
            || is_daemon_pid_helper(process.cmd())
            || under_broker(pid)
        {
            continue;
        }
        if is_background_codex(process.cmd()) {
            presence.background = true;
        } else {
            presence.open = true;
        }
    }
    if ask_brokers {
        for broker in brokers {
            let idle = broker_request(&broker.endpoint, "broker/status")
                .and_then(|status| status.get("busy").and_then(serde_json::Value::as_bool))
                == Some(false);
            if idle {
                presence.idle_brokers.push(broker);
            } else {
                // A busy broker runs a stock /codex command, and one that
                // cannot say (an older plugin) is treated the same way.
                presence.open = true;
            }
        }
    } else {
        presence.brokers_present = !brokers.is_empty();
    }
    let uncertain_node = system.processes().iter().any(|(pid, process)| {
        let pid = pid.as_u32();
        pid != std::process::id()
            && !excluded.contains(&pid)
            && is_node_process_without_command_line(process.name(), process.cmd())
    });
    if uncertain_node {
        return Err(
            "Unable to reliably inspect a running Node process. Quit Codex before changing the active account"
                .to_string(),
        );
    }
    Ok(presence)
}

fn published_worker_files() -> Vec<std::path::PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
    else {
        return Vec::new();
    };
    [".gswitchtool", ".gswitchtool-dev"]
        .into_iter()
        .map(|name| home.join(name).join("invoke-workers.json"))
        .collect()
}

#[derive(serde::Deserialize)]
struct PublishedWorkers {
    #[serde(default)]
    pids: Vec<u32>,
}

fn read_live_worker_pids(path: &std::path::Path, is_alive: impl Fn(u32) -> bool) -> Vec<u32> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PublishedWorkers>(&bytes).ok())
        .map(|workers| {
            workers
                .pids
                .into_iter()
                .filter(|pid| is_alive(*pid))
                .collect()
        })
        .unwrap_or_default()
}

fn extend_published_worker_pids(
    excluded: &mut HashSet<u32>,
    files: &[std::path::PathBuf],
    is_alive: impl Fn(u32) -> bool + Copy,
) {
    for path in files {
        excluded.extend(read_live_worker_pids(path, is_alive));
    }
}

/// Stops a process that GSwitch was told it owns, together with every process
/// it started. Callers pass only an Invoke worker's registered App Server.
pub fn terminate_process_tree(root: u32) {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    let mut tree = HashSet::from([root]);
    loop {
        let before = tree.len();
        let children = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                process
                    .parent()
                    .filter(|parent| tree.contains(&parent.as_u32()))
                    .map(|_| pid.as_u32())
            })
            .collect::<Vec<_>>();
        tree.extend(children);
        if tree.len() == before {
            break;
        }
    }
    for (pid, process) in system.processes() {
        if tree.contains(&pid.as_u32()) && pid.as_u32() != std::process::id() {
            let _ = process.kill();
        }
    }
}

pub fn process_alive(pid: u32) -> bool {
    let mut system = System::new();
    let pid = sysinfo::Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    system.process(pid).is_some()
}

fn is_codex_process(name: &OsStr, command: &[OsString]) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "codex" | "codex.exe" | "codex.cmd" | "codex.ps1"
    ) {
        return true;
    }

    let command = command
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
        .replace('\\', "/")
        .to_ascii_lowercase();
    command.contains("@openai/codex/")
        || command
            .split_whitespace()
            .any(|part| matches!(part, "codex" | "codex.exe" | "codex.cmd" | "codex.ps1"))
}

/// Codex's managed App Server daemon (`app-server --managed-daemon`),
/// installed under `~/.codex/packages/app-server-daemon`.
fn is_background_codex(command: &[OsString]) -> bool {
    let command = joined_command(command);
    command.contains("--managed-daemon") || command.contains("/.codex/packages/app-server-daemon/")
}

/// The daemon's `app-server daemon pid-update-loop` helper only tracks the
/// daemon's process ID. It holds no credential and outlives `daemon stop`.
fn is_daemon_pid_helper(command: &[OsString]) -> bool {
    joined_command(command).contains("app-server daemon pid-update-loop")
}

fn joined_command(command: &[OsString]) -> String {
    command
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn is_node_process_without_command_line(name: &OsStr, command: &[OsString]) -> bool {
    matches!(
        name.to_string_lossy().to_ascii_lowercase().as_str(),
        "node" | "node.exe"
    ) && command.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_native_and_npm_codex_processes() {
        assert!(is_codex_process(OsStr::new("codex.exe"), &[]));
        assert!(is_codex_process(
            OsStr::new("node.exe"),
            &[
                OsString::from("C:\\npm\\node.exe"),
                OsString::from("C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js")
            ]
        ));
    }

    #[test]
    fn published_worker_pids_are_added_to_external_codex_exclusions() {
        let root = std::env::temp_dir().join(format!("gswitch-workers-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("temp dir");
        let path = root.join("invoke-workers.json");
        std::fs::write(&path, br#"{"pids":[123,456]}"#).expect("worker file");
        let mut excluded = HashSet::new();
        extend_published_worker_pids(&mut excluded, std::slice::from_ref(&path), |pid| pid == 123);
        assert_eq!(excluded, HashSet::from([123]));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tells_the_windowless_daemon_apart_from_a_codex_the_user_opened() {
        let daemon = r"\\?\C:\Users\me\.codex\packages\app-server-daemon\releases\0.160.1-x86_64-pc-windows-msvc\bin\codex.exe";
        let command = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(is_background_codex(&command(&[
            daemon,
            "app-server",
            "--listen",
            "unix://",
            "--managed-daemon"
        ])));
        let helper = command(&[daemon, "app-server", "daemon", "pid-update-loop"]);
        assert!(is_daemon_pid_helper(&helper));
        assert!(!is_daemon_pid_helper(&command(&[
            daemon,
            "app-server",
            "--managed-daemon"
        ])));
        assert!(!is_background_codex(&command(&[
            r"C:\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
        ])));
        assert!(!is_background_codex(&command(&["codex.exe", "app-server"])));
        assert!(!is_background_codex(&command(&["codex", "resume"])));
    }

    /// Needs a running daemon and no other Codex open: first run
    /// `codex app-server daemon start` in a terminal (Codex refuses to start
    /// it under the test runner), then this test with `--ignored`.
    #[test]
    #[ignore]
    fn the_preflight_stops_the_real_codex_daemon_and_nothing_the_user_opened() {
        let presence = codex_presence(&[], true).expect("scan");
        assert!(!presence.open, "close every other Codex before this test");
        assert!(presence.background);
        assert!(external_codex_running(&[]).expect("scan"));
        assert!(!user_codex_open(&[]).expect("scan"));

        ensure_no_external_codex(&[]).expect("daemon stopped");
        assert_eq!(
            codex_presence(&[], true).expect("scan"),
            CodexPresence::default()
        );
    }

    /// Needs one idle Claude Code plugin broker and no other Codex open. Start
    /// one with the plugin's `ensureBrokerSession(cwd)` from
    /// `scripts/lib/broker-lifecycle.mjs` (no model request), then run this
    /// test with `--ignored`.
    #[test]
    #[ignore]
    fn the_preflight_stops_an_idle_plugin_broker_and_nothing_else() {
        let presence = codex_presence(&[], true).expect("scan");
        assert!(!presence.open, "close every other Codex before this test");
        assert_eq!(
            presence.idle_brokers.len(),
            1,
            "start one idle broker first"
        );
        assert!(external_codex_running(&[]).expect("scan"));
        assert!(!user_codex_open(&[]).expect("scan"));

        ensure_no_external_codex(&[]).expect("broker stopped");
        let after = codex_presence(&[], false).expect("scan");
        assert!(!after.brokers_present && !after.open);
    }

    #[test]
    fn finds_a_plugin_brokers_endpoint_on_its_command_line() {
        let command = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            broker_endpoint(&command(&[
                r"C:\Program Files\nodejs\node.exe",
                r"C:\Users\me\.claude\plugins\cache\gswitchtool\codex\1.0.6\scripts\app-server-broker.mjs",
                "serve",
                "--endpoint",
                r"pipe:\\.\pipe\cxc-abc-codex-app-server",
                "--cwd",
                r"C:\repo",
            ])),
            Some(r"pipe:\\.\pipe\cxc-abc-codex-app-server".to_string())
        );
        assert_eq!(
            broker_endpoint(&command(&[
                "node",
                "/x/app-server-broker.mjs",
                "serve",
                "--endpoint",
                "unix:/tmp/b.sock"
            ])),
            Some("unix:/tmp/b.sock".to_string())
        );
        // Not serving, no endpoint, or another script.
        assert_eq!(
            broker_endpoint(&command(&[
                "node",
                "/x/app-server-broker.mjs",
                "--endpoint",
                "unix:/a"
            ])),
            None
        );
        assert_eq!(
            broker_endpoint(&command(&["node", "/x/app-server-broker.mjs", "serve"])),
            None
        );
        assert_eq!(
            broker_endpoint(&command(&[
                "node",
                "/x/server.mjs",
                "serve",
                "--endpoint",
                "unix:/a"
            ])),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn asks_a_broker_over_its_pipe_and_gives_up_on_silence() {
        use tokio::{
            io::{AsyncBufReadExt, AsyncWriteExt},
            net::windows::named_pipe::ServerOptions,
        };
        let name = format!(r"\\.\pipe\gswitch-broker-test-{}", uuid::Uuid::new_v4());
        let server_name = name.clone();
        thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                // First client: answers status. Second: never answers.
                let server = ServerOptions::new()
                    .first_pipe_instance(true)
                    .create(&server_name)
                    .expect("pipe");
                server.connect().await.expect("connect");
                let next = ServerOptions::new().create(&server_name).expect("pipe");
                let (reader, mut writer) = tokio::io::split(server);
                let mut lines = tokio::io::BufReader::new(reader).lines();
                let request = lines.next_line().await.expect("read").expect("line");
                assert!(request.contains("broker/status"));
                writer
                    .write_all(b"{\"id\":1,\"result\":{\"busy\":false}}\n")
                    .await
                    .expect("write");
                let silent = next;
                silent.connect().await.expect("connect");
                tokio::time::sleep(Duration::from_secs(10)).await;
                drop(silent);
            });
        });
        thread::sleep(Duration::from_millis(200));
        let endpoint = format!("pipe:{name}");
        assert_eq!(
            broker_request(&endpoint, "broker/status"),
            Some(serde_json::json!({ "busy": false }))
        );
        let started = Instant::now();
        assert_eq!(broker_request(&endpoint, "broker/status"), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            broker_request(r"pipe:\\.\pipe\gswitch-no-such-broker", "broker/status"),
            None
        );
    }

    #[test]
    fn ignores_unrelated_node_and_source_file_names() {
        assert!(!is_codex_process(
            OsStr::new("node.exe"),
            &[OsString::from("C:\\work\\server.js")]
        ));
        assert!(!is_codex_process(
            OsStr::new("cargo.exe"),
            &[OsString::from("src/codex.rs")]
        ));
    }

    #[test]
    fn terminating_a_registered_process_also_stops_the_processes_it_started() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn");
        #[cfg(unix)]
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30; sleep 30"])
            .spawn()
            .expect("spawn");
        let root = child.id();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let grandchild = loop {
            let mut system = System::new();
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().without_tasks(),
            );
            if let Some(pid) = system.processes().iter().find_map(|(pid, process)| {
                (process.parent().map(|parent| parent.as_u32()) == Some(root))
                    .then_some(pid.as_u32())
            }) {
                break pid;
            }
            assert!(std::time::Instant::now() < deadline, "child did not start");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };

        terminate_process_tree(root);
        let _ = child.wait();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while process_alive(grandchild) {
            assert!(std::time::Instant::now() < deadline, "grandchild survived");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!process_alive(root));
    }

    #[test]
    fn marks_an_uninspectable_node_process_as_unsafe() {
        assert!(is_node_process_without_command_line(
            OsStr::new("node.exe"),
            &[]
        ));
        assert!(!is_node_process_without_command_line(
            OsStr::new("node.exe"),
            &[OsString::from("node.exe"), OsString::from("server.js")]
        ));
    }
}
