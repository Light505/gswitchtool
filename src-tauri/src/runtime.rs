use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// Detects only known Codex command lines. The caller must still perform a
/// second preflight immediately before changing the live auth file because a
/// process can start after this snapshot.
pub fn ensure_no_external_codex(excluded_pids: &[u32]) -> Result<(), String> {
    if external_codex_running(excluded_pids)? {
        return Err("Quit Codex before changing the active account".to_string());
    }
    Ok(())
}

/// Returns whether a known external Codex runtime is active. An
/// uninspectable Node process remains an error rather than being mistaken for
/// a safe absence. Wake uses this to skip only an account that matches the
/// externally active identity.
pub fn external_codex_running(excluded_pids: &[u32]) -> Result<bool, String> {
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

    let found = system.processes().iter().any(|(pid, process)| {
        let pid = pid.as_u32();
        pid != std::process::id()
            && !excluded.contains(&pid)
            && is_codex_process(process.name(), process.cmd())
    });
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
    Ok(found)
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
