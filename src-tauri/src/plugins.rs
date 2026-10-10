//! Read-only check of which GSwitch plugins Claude Code has installed. It reads
//! Claude Code's own `~/.claude/plugins/installed_plugins.json`, never writes,
//! and returns no paths.

use std::{fs, path::Path};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PluginStatus {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ClaudePlugins {
    pub codex: PluginStatus,
    pub router: PluginStatus,
}

fn status(plugins: &Value, name: &str) -> PluginStatus {
    match plugins.get(name) {
        Some(entry) => PluginStatus {
            installed: true,
            version: entry
                .as_array()
                .and_then(|list| list.first())
                .and_then(|first| first.get("version"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        None => PluginStatus::default(),
    }
}

/// The Codex and router plugin status for this build identity.
pub fn read(home: &Path, dev: bool) -> ClaudePlugins {
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Some(root) = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return ClaudePlugins::default();
    };
    let Some(plugins) = root.get("plugins") else {
        return ClaudePlugins::default();
    };
    let (codex, router) = if dev {
        ("codex-dev@gswitchtool-dev", "router-dev@gswitchtool-dev")
    } else {
        ("codex@gswitchtool", "router@gswitchtool")
    };
    ClaudePlugins {
        codex: status(plugins, codex),
        router: status(plugins, router),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_with(content: Option<&str>) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("gswitch-plugins-{}", uuid::Uuid::new_v4()));
        let dir = home.join(".claude").join("plugins");
        fs::create_dir_all(&dir).unwrap();
        if let Some(text) = content {
            fs::write(dir.join("installed_plugins.json"), text).unwrap();
        }
        home
    }

    const LIST: &str = r#"{"plugins":{
        "codex@gswitchtool":[{"scope":"user","installPath":"x","version":"1.0.6"}],
        "router-dev@gswitchtool-dev":[{"scope":"user","version":"0.5.0"}]}}"#;

    #[test]
    fn reads_installed_versions() {
        let home = home_with(Some(LIST));
        let found = read(&home, false);
        assert!(found.codex.installed);
        assert_eq!(found.codex.version.as_deref(), Some("1.0.6"));
        assert!(!found.router.installed);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn missing_file_means_not_installed() {
        let home = home_with(None);
        assert_eq!(read(&home, false), ClaudePlugins::default());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn corrupt_file_means_not_installed() {
        let home = home_with(Some("{ not json"));
        assert_eq!(read(&home, false), ClaudePlugins::default());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn dev_identity_uses_dev_names() {
        let home = home_with(Some(LIST));
        let found = read(&home, true);
        assert!(!found.codex.installed);
        assert!(found.router.installed);
        assert_eq!(found.router.version.as_deref(), Some("0.5.0"));
        let _ = fs::remove_dir_all(home);
    }
}
