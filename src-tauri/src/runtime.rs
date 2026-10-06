use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const QUIT_CODEX: &str = "Quit Codex before changing the active account";
const DAEMON_STOP_TIMEOUT: Duration = Duration::from_secs(15);
const DAEMON_EXIT_TIMEOUT: Duration = Duration::from_secs(10);

/// What Codex is running outside GSwitch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CodexPresence {
    /// A Codex the user opened: the app, the CLI, or an IDE extension.
    open: bool,
    /// Codex's managed App Server daemon, which has no window and keeps
    /// running after the user closes Codex.
    background: bool,
}

/// Detects only known Codex command lines. A Codex the user opened must be
/// closed by the user; Codex's windowless daemon is stopped here through its
/// official command, because it would otherwise keep the old credential. The
/// caller must still perform a second preflight immediately before changing
/// the live auth file because a process can start after this snapshot.
pub fn ensure_no_external_codex(excluded_pids: &[u32]) -> Result<(), String> {
    let presence = codex_presence(excluded_pids)?;
    if presence.open {
        return Err(QUIT_CODEX.to_string());
    }
    if presence.background {
        stop_background_codex(excluded_pids)?;
    }
    Ok(())
}

/// Returns whether a known external Codex runtime is active, including the
/// windowless daemon, which can also refresh credentials. An uninspectable
/// Node process remains an error rather than being mistaken for a safe
/// absence. Wake uses this to skip only an account that matches the
/// externally active identity.
pub fn external_codex_running(excluded_pids: &[u32]) -> Result<bool, String> {
    let presence = codex_presence(excluded_pids)?;
    Ok(presence.open || presence.background)
}

/// Returns whether a Codex the user opened is running. The windowless daemon
/// does not count: `ensure_no_external_codex` stops it before a switch.
pub fn user_codex_open(excluded_pids: &[u32]) -> Result<bool, String> {
    Ok(codex_presence(excluded_pids)?.open)
}

/// Stops Codex's managed App Server daemon with `codex app-server daemon stop`
/// and waits until it has exited. Codex starts it again when it next needs it.
fn stop_background_codex(excluded_pids: &[u32]) -> Result<(), String> {
    let mut command = crate::app_server::codex_command();
    command
        .args(["app-server", "daemon", "stop"])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|_| QUIT_CODEX.to_string())?;
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
    let deadline = Instant::now() + DAEMON_EXIT_TIMEOUT;
    loop {
        let presence = codex_presence(excluded_pids)?;
        if presence.open || (presence.background && Instant::now() >= deadline) {
            return Err(QUIT_CODEX.to_string());
        }
        if !presence.background {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
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

fn codex_presence(excluded_pids: &[u32]) -> Result<CodexPresence, String> {
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

    let mut presence = CodexPresence::default();
    for (pid, process) in system.processes() {
        let pid = pid.as_u32();
        if pid == std::process::id()
            || excluded.contains(&pid)
            || !is_codex_process(process.name(), process.cmd())
            || is_daemon_pid_helper(process.cmd())
        {
            continue;
        }
        if is_background_codex(process.cmd()) {
            presence.background = true;
        } else {
            presence.open = true;
        }
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
        let presence = codex_presence(&[]).expect("scan");
        assert!(!presence.open, "close every other Codex before this test");
        assert!(presence.background);
        assert!(external_codex_running(&[]).expect("scan"));
        assert!(!user_codex_open(&[]).expect("scan"));

        ensure_no_external_codex(&[]).expect("daemon stopped");
        assert_eq!(codex_presence(&[]).expect("scan"), CodexPresence::default());
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
