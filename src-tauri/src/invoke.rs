//! Human-owned Invoke Mode policy: whether Claude Code may delegate work to
//! Codex, and which Codex model/reasoning-effort combinations it may request.
//! The WebView commands are the only writers; request validation is read-only.

use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    app_server::{AppServer, TempCodexHome},
    model_access::ModelAccess,
    storage,
    types::{
        CatalogModel, ClaudeSetup, InvocationDefault, InvocationProfile, InvokeSettings,
        MAX_CONCURRENT_TASKS_LIMIT,
    },
};

#[cfg(test)]
use crate::types::ClaudeSetupKind;

const SETTINGS_LABEL: &str = "Invoke Mode settings";
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(30);
// `model/list` is paginated; a catalog this long would be a protocol fault.
const MAX_CATALOG_PAGES: i64 = 20;

/// Why a delegation request was refused before Codex started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InvokeRejection {
    InvokeModeDisabled,
    ModelNotAllowed,
    ReasoningNotAllowed,
}

#[derive(Clone)]
pub struct InvokeState {
    path: Arc<PathBuf>,
    settings: Arc<Mutex<InvokeSettings>>,
    catalog: Arc<Mutex<Option<Vec<CatalogModel>>>>,
    model_access: Arc<Mutex<ModelAccess>>,
    run_log: Arc<Mutex<()>>,
}

impl InvokeState {
    /// A missing or unreadable policy file starts with Invoke Mode off. The
    /// file holds no credentials, so the next human change rewrites it.
    pub fn load(path: PathBuf) -> Self {
        let mut settings = match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(error) if error.kind() == ErrorKind::NotFound => InvokeSettings::default(),
            Err(_) => InvokeSettings::default(),
        };
        settings.task_defaults = normalize_task_defaults(
            &settings.task_defaults,
            &settings.allowed_invocation_profiles,
        );
        Self {
            path: Arc::new(path),
            settings: Arc::new(Mutex::new(settings)),
            catalog: Arc::new(Mutex::new(None)),
            model_access: Arc::new(Mutex::new(ModelAccess::default())),
            run_log: Arc::new(Mutex::new(())),
        }
    }

    pub fn model_has_fast_tier(&self, model: &str) -> bool {
        self.cached_catalog().is_none_or(|catalog| {
            catalog
                .iter()
                .find(|entry| entry.model == model)
                .is_some_and(|entry| entry.service_tiers.iter().any(|tier| tier == "priority"))
        })
    }

    /// Logging is best-effort and serialized across workers. Errors reveal no task or provider data.
    pub fn append_codex_run(&self, run: &crate::failover::CodexRun) {
        let append = || -> Result<(), String> {
            let _guard = self
                .run_log
                .lock()
                .map_err(|_| "Run log lock unavailable")?;
            let path = self.path.with_file_name("codex-runs.jsonl");
            fs::create_dir_all(path.parent().ok_or("Invalid run log path")?)
                .map_err(|_| "Run log storage unavailable")?;
            let mut content = match fs::read_to_string(&path) {
                Ok(content) => content,
                Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
                Err(_) => return Err("Run log unreadable".to_string()),
            };
            let line = serde_json::to_string(run).map_err(|_| "Run log serialization failed")?;
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(&line);
            content.push('\n');
            let lines = content.lines().collect::<Vec<_>>();
            if lines.len() > 5000 {
                content = format!("{}\n", lines[lines.len() - 5000..].join("\n"));
            }
            storage::write_private_bytes_atomic(&path, content.as_bytes(), "Codex run log")
        };
        if append().is_err() {
            eprintln!("Warning: unable to write Codex run log");
        }
    }

    pub fn settings(&self) -> Result<InvokeSettings, String> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "Invoke Mode settings are unavailable".to_string())
    }

    #[cfg(test)]
    pub fn set_invoke_mode(&self, enabled: bool) -> Result<InvokeSettings, String> {
        self.update_with_setup(
            |settings| {
                settings.claude_setup.setup = if enabled {
                    ClaudeSetupKind::ClaudeCodex
                } else {
                    ClaudeSetupKind::ClaudeOnly
                };
                settings.invoke_mode = settings.claude_setup.invoke_mode();
            },
            true,
        )
    }

    /// Serde rejects unknown setup/model/effort values before this boundary.
    pub fn set_claude_setup(&self, mut setup: ClaudeSetup) -> Result<InvokeSettings, String> {
        if setup.codex_speed.fast_min_remaining > 90 {
            return Err("Fast cutoff must be between 0 and 90 percent".to_string());
        }
        setup.normalize();
        self.update_with_setup(
            |settings| {
                settings.invoke_mode = setup.invoke_mode();
                settings.claude_setup = setup;
            },
            true,
        )
    }

    /// Startup republishes the derived, credential-free plugin projection.
    pub fn publish_claude_setup(&self) -> Result<(), String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "Invoke Mode settings are unavailable".to_string())?;
        self.write_claude_setup(&settings.claude_setup)
    }

    fn write_claude_setup(&self, setup: &ClaudeSetup) -> Result<(), String> {
        #[derive(Serialize)]
        struct SharedSetup<'a> {
            version: u8,
            #[serde(flatten)]
            setup: &'a ClaudeSetup,
        }
        let content = serde_json::to_vec_pretty(&SharedSetup { version: 1, setup })
            .map_err(|_| "Unable to serialize Claude Code setup".to_string())?;
        let path = self.path.with_file_name("claude-setup.json");
        let parent = path.parent().ok_or("Invalid Claude Code setup path")?;
        fs::create_dir_all(parent).map_err(|_| "Unable to create storage for Claude Code setup")?;
        // Keep this non-secret projection's temporary path so failed renames
        // can be cleaned up. atomic-write-file 0.3.1 consumes that path on error.
        let temporary = parent.join(format!(".claude-setup.{}.tmp", uuid::Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Unable to prepare Claude Code setup")?;
        let result = file.write_all(&content).and_then(|()| file.sync_all());
        drop(file);
        let result = result.and_then(|()| fs::rename(&temporary, &path));
        if result.is_err() {
            fs::remove_file(&temporary).map_err(|_| {
                "Claude Code setup was not saved; unable to remove its temporary file"
            })?;
            return Err("Unable to atomically replace Claude Code setup".to_string());
        }
        Ok(())
    }

    /// Replaces the whitelist after checking it against `catalog`, which must
    /// come from the installed Codex App Server.
    pub fn set_profiles(
        &self,
        requested: &[InvocationProfile],
        catalog: &[CatalogModel],
    ) -> Result<InvokeSettings, String> {
        let profiles = normalize_profiles(requested, catalog)?;
        self.update(|settings| {
            settings.allowed_invocation_profiles = profiles;
            settings.task_defaults = normalize_task_defaults(
                &settings.task_defaults,
                &settings.allowed_invocation_profiles,
            );
        })
    }

    /// Stores only task suggestions that remain inside the allowed model/effort whitelist.
    pub fn set_task_defaults(
        &self,
        requested: std::collections::BTreeMap<String, InvocationDefault>,
    ) -> Result<InvokeSettings, String> {
        self.update(|settings| {
            settings.task_defaults =
                normalize_task_defaults(&requested, &settings.allowed_invocation_profiles);
        })
    }

    /// Sets the account order, the usage a preferred account must have left,
    /// and how many Codex tasks may run at once.
    pub fn set_preferences(
        &self,
        account_priority: Vec<String>,
        preferred_min_remaining: u8,
        max_concurrent_tasks: u8,
        auto_wake: bool,
    ) -> Result<InvokeSettings, String> {
        if preferred_min_remaining > 90 {
            return Err("Choose a usage threshold from 0% to 90%".to_string());
        }
        if !(1..=MAX_CONCURRENT_TASKS_LIMIT).contains(&max_concurrent_tasks) {
            return Err(format!(
                "Choose from 1 to {MAX_CONCURRENT_TASKS_LIMIT} Codex tasks at once"
            ));
        }
        let mut seen = std::collections::HashSet::new();
        let account_priority = account_priority
            .into_iter()
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect::<Vec<_>>();
        self.update(|settings| {
            settings.account_priority = account_priority;
            settings.preferred_min_remaining = preferred_min_remaining;
            settings.max_concurrent_tasks = max_concurrent_tasks;
            settings.auto_wake = auto_wake;
        })
    }

    /// Sets how much of each account's weekly window automatic choices leave
    /// unused. Zero entries are dropped.
    pub fn set_weekly_reserve(
        &self,
        reserve: std::collections::BTreeMap<String, u8>,
    ) -> Result<InvokeSettings, String> {
        if reserve.values().any(|percent| *percent > 90) {
            return Err("Choose a weekly reserve from 0% to 90%".to_string());
        }
        let reserve = reserve
            .into_iter()
            .filter(|(id, percent)| !id.is_empty() && *percent > 0)
            .collect();
        self.update(|settings| settings.weekly_reserve = reserve)
    }

    /// Checks one delegation request exactly against the human's policy. It
    /// never substitutes a different model or effort.
    pub fn validate_request(&self, model: &str, effort: &str) -> Result<(), InvokeRejection> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| InvokeRejection::InvokeModeDisabled)?;
        validate_request(&settings, model, effort)
    }

    pub fn cached_catalog(&self) -> Option<Vec<CatalogModel>> {
        self.catalog.lock().ok().and_then(|catalog| catalog.clone())
    }

    /// Which models each saved account can use, from the last read.
    pub fn model_access(&self) -> ModelAccess {
        self.model_access
            .lock()
            .map(|access| access.clone())
            .unwrap_or_default()
    }

    pub fn remember_model_access(&self, access: ModelAccess) {
        if let Ok(mut current) = self.model_access.lock() {
            *current = access;
        }
    }

    pub fn remember_catalog(&self, models: Vec<CatalogModel>) {
        if let Ok(mut catalog) = self.catalog.lock() {
            *catalog = Some(models);
        }
    }

    fn update<F>(&self, change: F) -> Result<InvokeSettings, String>
    where
        F: FnOnce(&mut InvokeSettings),
    {
        self.update_with_setup(change, false)
    }

    fn update_with_setup<F>(&self, change: F, publish_setup: bool) -> Result<InvokeSettings, String>
    where
        F: FnOnce(&mut InvokeSettings),
    {
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "Invoke Mode settings are unavailable".to_string())?;
        let mut candidate = settings.clone();
        change(&mut candidate);
        let value = serde_json::to_value(&candidate)
            .map_err(|_| format!("Unable to serialize {SETTINGS_LABEL}"))?;
        storage::write_json_atomic(&self.path, &value, SETTINGS_LABEL)?;
        if publish_setup || candidate.claude_setup != settings.claude_setup {
            if let Err(error) = self.write_claude_setup(&candidate.claude_setup) {
                // Restore the saved owner; memory advances only after publication.
                let previous = serde_json::to_value(&*settings)
                    .map_err(|_| format!("Unable to serialize {SETTINGS_LABEL}"))?;
                storage::write_json_atomic(&self.path, &previous, SETTINGS_LABEL)
                    .map_err(|rollback| format!("{error}; {rollback}"))?;
                return Err(error);
            }
        }
        *settings = candidate.clone();
        Ok(candidate)
    }
}

fn normalize_task_defaults(
    requested: &std::collections::BTreeMap<String, InvocationDefault>,
    profiles: &[InvocationProfile],
) -> std::collections::BTreeMap<String, InvocationDefault> {
    const KINDS: [&str; 4] = ["review", "research", "mechanical", "complex"];
    requested
        .iter()
        .filter(|(kind, default)| {
            KINDS.contains(&kind.as_str())
                && profiles.iter().any(|profile| {
                    profile.model == default.model
                        && profile.reasoning_efforts.contains(&default.effort)
                })
        })
        .map(|(kind, default)| (kind.clone(), default.clone()))
        .collect()
}

fn validate_request(
    settings: &InvokeSettings,
    model: &str,
    effort: &str,
) -> Result<(), InvokeRejection> {
    if !settings.invoke_mode {
        return Err(InvokeRejection::InvokeModeDisabled);
    }
    let profile = settings
        .allowed_invocation_profiles
        .iter()
        .find(|profile| profile.model == model)
        .ok_or(InvokeRejection::ModelNotAllowed)?;
    if !profile
        .reasoning_efforts
        .iter()
        .any(|allowed| allowed == effort)
    {
        return Err(InvokeRejection::ReasoningNotAllowed);
    }
    Ok(())
}

/// Keeps only combinations the installed Codex reports, in catalog order, so
/// the stored whitelist never claims a model/effort pair Codex cannot run.
fn normalize_profiles(
    requested: &[InvocationProfile],
    catalog: &[CatalogModel],
) -> Result<Vec<InvocationProfile>, String> {
    for profile in requested {
        let model = catalog
            .iter()
            .find(|model| model.model == profile.model)
            .ok_or_else(|| format!("Codex does not offer the model {}", profile.model))?;
        if let Some(effort) = profile
            .reasoning_efforts
            .iter()
            .find(|effort| !model.supported_reasoning_efforts.contains(effort))
        {
            return Err(format!(
                "{} does not support the {effort} reasoning effort",
                profile.model
            ));
        }
    }

    Ok(catalog
        .iter()
        .filter_map(|model| {
            let efforts = model
                .supported_reasoning_efforts
                .iter()
                .filter(|effort| {
                    requested.iter().any(|profile| {
                        profile.model == model.model && profile.reasoning_efforts.contains(effort)
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            (!efforts.is_empty()).then(|| InvocationProfile {
                model: model.model.clone(),
                reasoning_efforts: efforts,
            })
        })
        .collect())
}

/// Reads the model catalog from the installed Codex App Server in an empty,
/// GSwitch-owned profile. No credential is copied into that profile.
pub fn read_model_catalog(isolated_root: &Path) -> Result<Vec<CatalogModel>, String> {
    let home = TempCodexHome::create(isolated_root)?;
    let mut server = AppServer::start(&home.path)?;
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 1..=MAX_CATALOG_PAGES {
        let result = server.call(
            page,
            "model/list",
            json!({ "cursor": cursor, "includeHidden": false }),
            MODEL_LIST_TIMEOUT,
        )?;
        let (page_models, next_cursor) = parse_model_list(&result)?;
        models.extend(page_models);
        match next_cursor {
            Some(next) => cursor = Some(next),
            None => {
                drop(server);
                let _ = home.cleanup();
                return Ok(models);
            }
        }
    }
    Err("Codex returned an unexpectedly long model catalog".to_string())
}

fn parse_model_list(result: &Value) -> Result<(Vec<CatalogModel>, Option<String>), String> {
    let data = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex returned an unreadable model catalog".to_string())?;
    let models = data
        .iter()
        .filter(|entry| {
            !entry
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let model = entry
                .get("model")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)?
                .to_string();
            let supported_reasoning_efforts = entry
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .map(|efforts| {
                    efforts
                        .iter()
                        .filter_map(|option| {
                            option
                                .get("reasoningEffort")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(CatalogModel {
                display_name: entry
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&model)
                    .to_string(),
                model,
                supported_reasoning_efforts,
                service_tiers: entry
                    .get("serviceTiers")
                    .and_then(Value::as_array)
                    .map(|tiers| {
                        tiers
                            .iter()
                            .filter_map(|tier| {
                                tier.get("id").and_then(Value::as_str).map(str::to_string)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                default_reasoning_effort: entry
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                is_default: entry
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                only_on: None,
            })
        })
        .collect();
    let next_cursor = result
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_string);
    Ok((models, next_cursor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ClaudeSetupKind;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn the_weekly_reserve_keeps_only_real_entries_in_range() {
        let path = temp_path("reserve");
        let state = InvokeState::load(path.clone());
        let saved = state
            .set_weekly_reserve(std::collections::BTreeMap::from([
                ("a".to_string(), 30),
                ("b".to_string(), 0),
                (String::new(), 10),
            ]))
            .expect("save");
        assert_eq!(
            saved.weekly_reserve,
            std::collections::BTreeMap::from([("a".to_string(), 30)])
        );
        assert!(state
            .set_weekly_reserve(std::collections::BTreeMap::from([("a".to_string(), 95)]))
            .is_err());
        assert_eq!(
            InvokeState::load(path.clone()).settings().expect("reload"),
            saved
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn preferences_keep_one_entry_per_account_and_stay_in_range() {
        let path = temp_path("preferences");
        let state = InvokeState::load(path.clone());
        let defaults = state.settings().expect("settings");
        assert_eq!(
            (
                defaults.preferred_min_remaining,
                defaults.max_concurrent_tasks
            ),
            (20, 2)
        );
        assert!(!defaults.auto_wake);

        let saved = state
            .set_preferences(
                vec!["b".into(), "a".into(), "b".into(), String::new()],
                35,
                3,
                true,
            )
            .expect("save");
        assert_eq!(
            saved.account_priority,
            vec!["b".to_string(), "a".to_string()]
        );
        assert_eq!(
            (saved.preferred_min_remaining, saved.max_concurrent_tasks),
            (35, 3)
        );
        assert!(saved.auto_wake);
        assert_eq!(
            InvokeState::load(path.clone()).settings().expect("reload"),
            saved
        );

        assert!(state.set_preferences(Vec::new(), 91, 2, false).is_err());
        assert!(state.set_preferences(Vec::new(), 20, 0, false).is_err());
        assert!(state.set_preferences(Vec::new(), 20, 7, false).is_err());
        assert_eq!(state.settings().expect("unchanged"), saved);

        // A policy file from an older version gets the defaults.
        std::fs::write(
            &path,
            r#"{"invoke_mode":true,"allowed_invocation_profiles":[]}"#,
        )
        .expect("write");
        let older = InvokeState::load(path.clone()).settings().expect("older");
        assert!(older.invoke_mode);
        assert_eq!(
            (older.preferred_min_remaining, older.max_concurrent_tasks),
            (20, 2)
        );
        assert!(!older.auto_wake);
        let _ = std::fs::remove_dir_all(path.parent().expect("dir"));
    }

    fn temp_path(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("gswitch-invoke-{name}-{suffix}"))
            .join("invoke.json")
    }

    #[test]
    fn legacy_setup_derives_from_both_invoke_modes() {
        for enabled in [false, true] {
            let path = temp_path("legacy-setup");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, json!({ "invoke_mode": enabled }).to_string()).unwrap();
            let state = InvokeState::load(path.clone());
            let settings = state.settings().unwrap();
            assert_eq!(
                settings.claude_setup,
                ClaudeSetup::from_invoke_mode(enabled)
            );
            assert_eq!(settings.invoke_mode, enabled);
            state.publish_claude_setup().unwrap();
            let shared: Value = serde_json::from_slice(
                &fs::read(path.with_file_name("claude-setup.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                shared["setup"],
                if enabled {
                    "claude-codex"
                } else {
                    "claude-only"
                }
            );
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn every_setup_mode_and_review_combination_derives_invoke_mode() {
        use crate::types::{ClaudeOnlyReview, ClaudeRouterMode, ClaudeRouterOptions};
        let path = temp_path("setup-combinations");
        let state = InvokeState::load(path.clone());
        for kind in [
            ClaudeSetupKind::ClaudeOnly,
            ClaudeSetupKind::ClaudeCodex,
            ClaudeSetupKind::Router,
        ] {
            for mode in [
                ClaudeRouterMode::Mixed,
                ClaudeRouterMode::Claude,
                ClaudeRouterMode::Codex,
            ] {
                for review in [ClaudeOnlyReview::On, ClaudeOnlyReview::Off] {
                    let setup = ClaudeSetup {
                        setup: kind,
                        codex_speed: Default::default(),
                        router: ClaudeRouterOptions {
                            mode,
                            claude_only_review: review,
                            ..ClaudeRouterOptions::default()
                        },
                    };
                    let expected = kind == ClaudeSetupKind::ClaudeCodex
                        || (kind == ClaudeSetupKind::Router
                            && (mode != ClaudeRouterMode::Claude
                                || review == ClaudeOnlyReview::On));
                    let saved = state.set_claude_setup(setup.clone()).unwrap();
                    assert_eq!(saved.invoke_mode, expected);
                    assert_eq!(saved.claude_setup, setup);
                    assert_eq!(InvokeState::load(path.clone()).settings().unwrap(), saved);
                }
            }
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn setup_command_payload_rejects_unknown_options() {
        let valid = serde_json::to_value(ClaudeSetup::default()).unwrap();
        for pointer in [
            "/setup",
            "/router/mode",
            "/router/claudeOnlyReview",
            "/router/claudeAllowed/haiku/0",
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = json!("unknown");
            assert!(
                serde_json::from_value::<ClaudeSetup>(invalid).is_err(),
                "{pointer}"
            );
        }
        let mut unknown_model = valid;
        unknown_model["router"]["claudeAllowed"]["unknown"] = json!(["low"]);
        assert!(serde_json::from_value::<ClaudeSetup>(unknown_model).is_err());
    }

    #[test]
    fn setup_prefer_defaults_for_old_files_and_round_trips() {
        use crate::types::ClaudeRouterPrefer;
        let mut old = serde_json::to_value(ClaudeSetup::default()).unwrap();
        old["router"].as_object_mut().unwrap().remove("prefer");
        let setup: ClaudeSetup = serde_json::from_value(old).unwrap();
        assert_eq!(setup.router.prefer, ClaudeRouterPrefer::Codex);
        for prefer in ["codex", "claude", "price"] {
            let mut value = serde_json::to_value(&setup).unwrap();
            value["router"]["prefer"] = json!(prefer);
            let parsed: ClaudeSetup = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }
    }

    #[test]
    fn invalid_setup_prefer_loads_without_resetting_policy() {
        use crate::types::ClaudeRouterPrefer;
        let path = temp_path("invalid-setup-prefer");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let policy = json!({
            "invoke_mode": true,
            "claude_setup": {
                "setup": "router",
                "router": {
                    "mode": "codex",
                    "prefer": "codex",
                    "claudeAllowed": { "haiku": ["high"], "sonnet": ["low"], "opus": [] },
                    "claudeOnlyReview": "off"
                }
            },
            "allowed_invocation_profiles": [{ "model": "gpt-6.1-sol", "reasoning_efforts": ["low"] }],
            "account_priority": ["saved-account"],
            "preferred_min_remaining": 35,
            "max_concurrent_tasks": 3,
            "auto_wake": true
        });
        let expected: InvokeSettings = serde_json::from_value(policy.clone()).unwrap();
        let mut omitted = policy.clone();
        omitted["claude_setup"]["router"]
            .as_object_mut()
            .unwrap()
            .remove("prefer");
        fs::write(&path, omitted.to_string()).unwrap();
        assert_eq!(
            InvokeState::load(path.clone()).settings().unwrap(),
            expected
        );
        for prefer in [
            json!("unknown"),
            Value::Null,
            json!(42),
            json!(false),
            json!([]),
            json!({}),
        ] {
            let mut invalid = policy.clone();
            invalid["claude_setup"]["router"]["prefer"] = prefer;
            fs::write(&path, invalid.to_string()).unwrap();
            let loaded = InvokeState::load(path.clone()).settings().unwrap();
            assert_eq!(loaded.claude_setup.router.prefer, ClaudeRouterPrefer::Codex);
            assert!(loaded.invoke_mode);
            assert_eq!(loaded, expected);
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn setup_sampling_defaults_for_old_files_and_round_trips() {
        use crate::types::ClaudeRouterSampling;
        let mut old = serde_json::to_value(ClaudeSetup::default()).unwrap();
        old["router"].as_object_mut().unwrap().remove("sampling");
        let setup: ClaudeSetup = serde_json::from_value(old).unwrap();
        assert_eq!(setup.router.sampling, ClaudeRouterSampling::On);
        for sampling in ["on", "off"] {
            let mut value = serde_json::to_value(&setup).unwrap();
            value["router"]["sampling"] = json!(sampling);
            let parsed: ClaudeSetup = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }
    }

    #[test]
    fn invalid_setup_sampling_loads_without_resetting_policy() {
        use crate::types::ClaudeRouterSampling;
        let path = temp_path("invalid-setup-sampling");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let policy = json!({
            "invoke_mode": true,
            "claude_setup": {
                "setup": "router",
                "router": {
                    "mode": "codex",
                    "prefer": "claude",
                    "sampling": "on",
                    "claudeAllowed": { "haiku": ["high"], "sonnet": ["low"], "opus": [] },
                    "claudeOnlyReview": "off"
                }
            },
            "allowed_invocation_profiles": [{ "model": "gpt-6.1-sol", "reasoning_efforts": ["low"] }],
            "account_priority": ["saved-account"],
            "preferred_min_remaining": 35,
            "max_concurrent_tasks": 3,
            "auto_wake": true
        });
        let expected: InvokeSettings = serde_json::from_value(policy.clone()).unwrap();
        let mut omitted = policy.clone();
        omitted["claude_setup"]["router"]
            .as_object_mut()
            .unwrap()
            .remove("sampling");
        fs::write(&path, omitted.to_string()).unwrap();
        assert_eq!(
            InvokeState::load(path.clone()).settings().unwrap(),
            expected
        );
        for sampling in [
            json!("unknown"),
            Value::Null,
            json!(42),
            json!(false),
            json!([]),
            json!({}),
        ] {
            let mut invalid = policy.clone();
            invalid["claude_setup"]["router"]["sampling"] = sampling;
            fs::write(&path, invalid.to_string()).unwrap();
            let loaded = InvokeState::load(path.clone()).settings().unwrap();
            assert_eq!(
                loaded.claude_setup.router.sampling,
                ClaudeRouterSampling::On
            );
            assert!(loaded.invoke_mode);
            assert_eq!(loaded, expected);
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn shared_setup_has_exact_shape_order_and_leaves_no_temporary_file() {
        use crate::types::ClaudeEffort;
        let path = temp_path("shared-setup");
        let state = InvokeState::load(path.clone());
        let mut setup = ClaudeSetup::default();
        setup.router.claude_allowed.haiku =
            vec![ClaudeEffort::Medium, ClaudeEffort::Low, ClaudeEffort::Low];
        setup.router.claude_allowed.sonnet = vec![ClaudeEffort::Low];
        setup.router.claude_allowed.opus.clear();
        let saved = state.set_claude_setup(setup).unwrap();
        let content = fs::read_to_string(path.with_file_name("claude-setup.json")).unwrap();
        let shared: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            shared,
            json!({
                "version": 1,
                "setup": "claude-only",
                "router": {
                    "mode": "mixed",
                    "prefer": "codex",
                    "sampling": "on",
                    "claudeAllowed": { "haiku": ["low", "medium"], "sonnet": ["low"], "opus": [] },
                    "claudeOnlyReview": "on"
                },
                "codexSpeed": { "mode": "normal", "fastMinRemaining": 20 }
            })
        );
        assert!(content.find("\"prefer\"").unwrap() < content.find("\"sampling\"").unwrap());
        assert!(content.find("\"haiku\"").unwrap() < content.find("\"sonnet\"").unwrap());
        assert!(content.find("\"sonnet\"").unwrap() < content.find("\"opus\"").unwrap());
        assert_eq!(
            saved.claude_setup.router.claude_allowed.haiku,
            vec![ClaudeEffort::Low, ClaudeEffort::Medium]
        );
        state
            .set_claude_setup(ClaudeSetup::from_invoke_mode(true))
            .unwrap();
        let mut names = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, vec!["claude-setup.json", "invoke.json"]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn failed_shared_setup_write_restores_saved_and_in_memory_policy() {
        let path = temp_path("shared-setup-failure");
        let state = InvokeState::load(path.clone());
        let original = state.set_claude_setup(ClaudeSetup::default()).unwrap();
        let shared_path = path.with_file_name("claude-setup.json");
        fs::remove_file(&shared_path).unwrap();
        fs::create_dir(&shared_path).unwrap();
        assert!(state
            .set_claude_setup(ClaudeSetup::from_invoke_mode(true))
            .is_err());
        assert_eq!(state.settings().unwrap(), original);
        assert_eq!(
            InvokeState::load(path.clone()).settings().unwrap(),
            original
        );
        let mut names = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, vec!["claude-setup.json", "invoke.json"]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn locked_shared_setup_keeps_original_file_and_removes_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = temp_path("setup-locked");
        let state = InvokeState::load(path.clone());
        let original = state.set_claude_setup(ClaudeSetup::default()).unwrap();
        let shared_path = path.with_file_name("claude-setup.json");
        let content = fs::read(&shared_path).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&shared_path)
            .unwrap();
        assert!(state
            .set_claude_setup(ClaudeSetup::from_invoke_mode(true))
            .is_err());
        assert_eq!(state.settings().unwrap(), original);
        assert_eq!(
            InvokeState::load(path.clone()).settings().unwrap(),
            original
        );
        drop(held);
        assert_eq!(fs::read(&shared_path).unwrap(), content);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 2);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn failed_policy_write_leaves_shared_setup_and_memory_unchanged() {
        let path = temp_path("setup-owner-failure");
        let state = InvokeState::load(path.clone());
        state.publish_claude_setup().unwrap();
        let shared_path = path.with_file_name("claude-setup.json");
        let original_shared = fs::read(&shared_path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(state
            .set_claude_setup(ClaudeSetup::from_invoke_mode(true))
            .is_err());
        assert_eq!(state.settings().unwrap(), InvokeSettings::default());
        assert_eq!(fs::read(shared_path).unwrap(), original_shared);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn startup_publication_replaces_a_stale_projection() {
        let path = temp_path("setup-startup");
        let state = InvokeState::load(path.clone());
        let saved = state
            .set_claude_setup(ClaudeSetup::from_invoke_mode(true))
            .unwrap();
        fs::write(path.with_file_name("claude-setup.json"), "{}").unwrap();
        let reloaded = InvokeState::load(path.clone());
        reloaded.publish_claude_setup().unwrap();
        let shared: Value =
            serde_json::from_slice(&fs::read(path.with_file_name("claude-setup.json")).unwrap())
                .unwrap();
        assert_eq!(shared["setup"], "claude-codex");
        assert_eq!(reloaded.settings().unwrap(), saved);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn setup_speed_defaults_for_old_files_and_round_trips() {
        let mut old = serde_json::to_value(ClaudeSetup::default()).unwrap();
        old.as_object_mut().unwrap().remove("codexSpeed");
        let setup: ClaudeSetup = serde_json::from_value(old).unwrap();
        assert_eq!(setup.codex_speed, crate::types::CodexSpeed::default());
        let path = temp_path("speed-round-trip");
        let state = InvokeState::load(path.clone());
        for mode in ["normal", "fast", "orchestrator"] {
            for cutoff in [0, 20, 90] {
                let mut value = serde_json::to_value(&setup).unwrap();
                value["codexSpeed"] = json!({ "mode": mode, "fastMinRemaining": cutoff });
                let parsed: ClaudeSetup = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
                let saved = state.set_claude_setup(parsed).unwrap();
                assert_eq!(InvokeState::load(path.clone()).settings().unwrap(), saved);
                let shared: Value = serde_json::from_slice(
                    &fs::read(path.with_file_name("claude-setup.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(shared["codexSpeed"], value["codexSpeed"]);
            }
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn invalid_setup_speed_loads_without_resetting_policy() {
        let path = temp_path("invalid-setup-speed");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let policy = json!({
            "invoke_mode": true,
            "claude_setup": {
                "setup": "router",
                "router": {
                    "mode": "codex", "prefer": "claude",
                    "claudeAllowed": { "haiku": ["high"], "sonnet": ["low"], "opus": [] },
                    "claudeOnlyReview": "off"
                }
            },
            "allowed_invocation_profiles": [{ "model": "gpt-6.1-sol", "reasoning_efforts": ["low"] }],
            "task_defaults": { "research": { "model": "gpt-6.1-sol", "effort": "low" } },
            "account_priority": ["saved-account"],
            "preferred_min_remaining": 35, "max_concurrent_tasks": 3, "auto_wake": true,
            "weekly_reserve": { "saved-account": 10 }
        });
        let expected: InvokeSettings = serde_json::from_value(policy.clone()).unwrap();
        for speed in [
            Value::Null,
            json!(false),
            json!(42),
            json!([]),
            json!("fast"),
            json!({}),
            json!({ "mode": "unknown", "fastMinRemaining": 91 }),
            json!({ "mode": false, "fastMinRemaining": -1 }),
            json!({ "mode": {}, "fastMinRemaining": 20.5 }),
            json!({ "mode": [], "fastMinRemaining": "20" }),
            json!({ "mode": null, "fastMinRemaining": null }),
        ] {
            let mut invalid = policy.clone();
            invalid["claude_setup"]["codexSpeed"] = speed;
            fs::write(&path, invalid.to_string()).unwrap();
            assert_eq!(
                InvokeState::load(path.clone()).settings().unwrap(),
                expected
            );
        }
        let mut integer = policy.clone();
        integer["claude_setup"]["codexSpeed"] = json!({ "mode": "fast", "fastMinRemaining": 35.0 });
        let loaded: InvokeSettings = serde_json::from_value(integer).unwrap();
        assert_eq!(loaded.claude_setup.codex_speed.fast_min_remaining, 35);
        let mut partial = policy.clone();
        partial["claude_setup"]["codexSpeed"] = json!({ "mode": "bad", "fastMinRemaining": 35 });
        let loaded: InvokeSettings = serde_json::from_value(partial.clone()).unwrap();
        assert_eq!(loaded.claude_setup.codex_speed.fast_min_remaining, 35);
        partial["claude_setup"]["codexSpeed"] = json!({ "mode": "fast", "fastMinRemaining": 99 });
        let loaded: InvokeSettings = serde_json::from_value(partial).unwrap();
        assert_eq!(
            loaded.claude_setup.codex_speed.mode,
            crate::types::CodexSpeedMode::Fast
        );
        assert_eq!(loaded.claude_setup.codex_speed.fast_min_remaining, 20);

        let state = InvokeState::load(path.clone());
        let mut invalid = expected.claude_setup.clone();
        invalid.codex_speed.fast_min_remaining = 91;
        assert!(state.set_claude_setup(invalid).is_err());
        assert_eq!(state.settings().unwrap(), expected);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn comparison_run() -> crate::failover::CodexRun {
        crate::failover::CodexRun {
            version: 1,
            time: "2026-10-10T12:00:00.000Z".into(),
            job_id: Some("task-1".into()),
            thread_id: Some("thread-1".into()),
            model: "model-a".into(),
            effort: "high".into(),
            write: false,
            status: "completed".into(),
            code: None,
            speed_requested: Some(crate::types::CodexSpeedMode::Fast),
            speed_reason: Some("blocks the next step".into()),
            speed: "mixed",
            speed_notes: vec!["usage unknown".into()],
            codex_ms: Some(123),
            total_ms: Some(456),
            tokens: Some(789),
            self_report: Some(crate::failover::SelfReport {
                status: Some("done"),
                confidence: Some("medium"),
                felt: None,
                verify_fails: Some(0),
            }),
            files_changed: Some(2),
            lines_added: Some(10),
            lines_deleted: Some(3),
            verify: Some("passed"),
            verify_retries: Some(0),
            scope_requests: Some(1),
            token_breakdown: Some(crate::failover::TokenBreakdown {
                input: 700,
                cached_input: 500,
                output: 89,
                reasoning_output: 40,
            }),
            long_prompt_tokens: None,
        }
    }

    #[test]
    fn invoke_fast_support_uses_the_catalog_only_when_known() {
        let state = InvokeState::load(temp_path("fast-catalog"));
        assert!(state.model_has_fast_tier("model-a"));
        state.remember_catalog(catalog());
        assert!(state.model_has_fast_tier("model-a"));
        assert!(!state.model_has_fast_tier("model-b"));
        assert!(!state.model_has_fast_tier("model-unknown"));
    }

    #[test]
    fn invoke_run_log_has_exact_shape_and_keeps_the_newest_5000_entries() {
        let path = temp_path("run-log");
        let state = InvokeState::load(path.clone());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let log = path.with_file_name("codex-runs.jsonl");
        fs::write(
            &log,
            (0..5000)
                .map(|n| format!("{{\"old\":{n}}}\n"))
                .collect::<String>(),
        )
        .unwrap();
        state.append_codex_run(&comparison_run());
        let content = fs::read_to_string(&log).unwrap();
        let lines = content.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 5000);
        assert_eq!(lines[0], "{\"old\":1}");
        assert_eq!(
            serde_json::from_str::<Value>(lines[4999]).unwrap(),
            json!({
                "version": 1, "time": "2026-10-10T12:00:00.000Z", "jobId": "task-1",
                "threadId": "thread-1", "model": "model-a", "effort": "high", "write": false,
                "status": "completed", "code": null, "speedRequested": "fast",
                "speedReason": "blocks the next step", "speed": "mixed",
                "speedNotes": ["usage unknown"], "codexMs": 123, "totalMs": 456, "tokens": 789,
                "selfReport": { "status": "done", "confidence": "medium", "felt": null, "verifyFails": 0 },
                "filesChanged": 2, "linesAdded": 10, "linesDeleted": 3, "verify": "passed",
                "verifyRetries": 0, "scopeRequests": 1,
                "tokenBreakdown": { "input": 700, "cachedInput": 500, "output": 89, "reasoningOutput": 40 },
                "longPromptTokens": null
            })
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn invoke_run_log_serializes_workers_and_write_failure_is_best_effort() {
        let path = temp_path("run-log-concurrency");
        let state = InvokeState::load(path.clone());
        let workers = (0..8)
            .map(|_| {
                let state = state.clone();
                std::thread::spawn(move || state.append_codex_run(&comparison_run()))
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }
        let log = path.with_file_name("codex-runs.jsonl");
        let content = fs::read_to_string(&log).unwrap();
        assert_eq!(content.lines().count(), 8);
        for line in content.lines() {
            assert!(serde_json::from_str::<Value>(line).is_ok());
        }
        fs::remove_file(&log).unwrap();
        fs::create_dir(&log).unwrap();
        state.append_codex_run(&comparison_run());
        assert!(log.is_dir());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn catalog() -> Vec<CatalogModel> {
        vec![
            CatalogModel {
                model: "model-a".into(),
                display_name: "Model A".into(),
                supported_reasoning_efforts: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                ],
                service_tiers: vec!["priority".into()],
                default_reasoning_effort: Some("medium".into()),
                is_default: true,
                only_on: None,
            },
            CatalogModel {
                model: "model-b".into(),
                display_name: "Model B".into(),
                supported_reasoning_efforts: vec!["low".into(), "medium".into()],
                service_tiers: Vec::new(),
                default_reasoning_effort: None,
                is_default: false,
                only_on: None,
            },
        ]
    }

    fn profile(model: &str, efforts: &[&str]) -> InvocationProfile {
        InvocationProfile {
            model: model.into(),
            reasoning_efforts: efforts.iter().map(|effort| effort.to_string()).collect(),
        }
    }

    fn enabled(profiles: Vec<InvocationProfile>) -> InvokeSettings {
        InvokeSettings {
            invoke_mode: true,
            claude_setup: ClaudeSetup::from_invoke_mode(true),
            allowed_invocation_profiles: profiles,
            ..InvokeSettings::default()
        }
    }

    #[test]
    fn a_missing_or_damaged_policy_starts_with_invoke_mode_off() {
        let missing = InvokeState::load(temp_path("missing"));
        assert_eq!(
            missing.settings().expect("settings"),
            InvokeSettings::default()
        );

        let damaged_path = temp_path("damaged");
        fs::create_dir_all(damaged_path.parent().expect("parent")).expect("dir");
        fs::write(&damaged_path, "{ not json").expect("write");
        let damaged = InvokeState::load(damaged_path.clone());
        assert!(!damaged.settings().expect("settings").invoke_mode);
        let _ = fs::remove_dir_all(damaged_path.parent().expect("parent"));
    }

    #[test]
    fn policy_changes_persist_across_reload() {
        let path = temp_path("persist");
        let state = InvokeState::load(path.clone());
        state.set_invoke_mode(true).expect("enable");
        state
            .set_profiles(&[profile("model-b", &["medium"])], &catalog())
            .expect("profiles");

        let reloaded = InvokeState::load(path.clone());
        assert_eq!(
            reloaded.settings().expect("settings"),
            enabled(vec![profile("model-b", &["medium"])])
        );
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn a_rejected_whitelist_leaves_the_saved_policy_unchanged() {
        let path = temp_path("rejected");
        let state = InvokeState::load(path.clone());
        state
            .set_profiles(&[profile("model-a", &["high"])], &catalog())
            .expect("profiles");

        let error = state
            .set_profiles(&[profile("model-b", &["xhigh"])], &catalog())
            .expect_err("model-b has no xhigh");
        assert_eq!(error, "model-b does not support the xhigh reasoning effort");
        assert_eq!(
            state
                .settings()
                .expect("settings")
                .allowed_invocation_profiles,
            vec![profile("model-a", &["high"])]
        );
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn whitelist_rejects_models_codex_does_not_offer() {
        let error = normalize_profiles(&[profile("model-z", &["low"])], &catalog())
            .expect_err("unknown model");
        assert_eq!(error, "Codex does not offer the model model-z");
    }

    #[test]
    fn whitelist_is_deduplicated_ordered_by_catalog_and_drops_empty_models() {
        let normalized = normalize_profiles(
            &[
                profile("model-b", &[]),
                profile("model-a", &["xhigh", "low", "xhigh"]),
                profile("model-a", &["medium"]),
            ],
            &catalog(),
        )
        .expect("normalized");
        assert_eq!(
            normalized,
            vec![profile("model-a", &["low", "medium", "xhigh"])]
        );
    }

    #[test]
    fn task_defaults_drop_models_efforts_and_kinds_outside_the_whitelist() {
        let path = temp_path("task-defaults");
        let state = InvokeState::load(path.clone());
        state
            .set_profiles(&[profile("model-a", &["high"])], &catalog())
            .expect("profiles");
        let saved = state
            .set_task_defaults(std::collections::BTreeMap::from([
                (
                    "review".into(),
                    InvocationDefault {
                        model: "model-a".into(),
                        effort: "high".into(),
                    },
                ),
                (
                    "research".into(),
                    InvocationDefault {
                        model: "model-a".into(),
                        effort: "low".into(),
                    },
                ),
                (
                    "complex".into(),
                    InvocationDefault {
                        model: "model-b".into(),
                        effort: "medium".into(),
                    },
                ),
                (
                    "other".into(),
                    InvocationDefault {
                        model: "model-a".into(),
                        effort: "high".into(),
                    },
                ),
            ]))
            .expect("defaults");
        assert_eq!(
            saved.task_defaults.keys().cloned().collect::<Vec<_>>(),
            vec!["review"]
        );
        state
            .set_profiles(&[profile("model-a", &["low"])], &catalog())
            .expect("new profiles");
        assert!(state.settings().expect("settings").task_defaults.is_empty());
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn requests_are_checked_exactly_against_the_policy() {
        let settings = enabled(vec![
            profile("model-a", &["high", "xhigh"]),
            profile("model-b", &["medium"]),
        ]);
        assert_eq!(validate_request(&settings, "model-a", "xhigh"), Ok(()));
        assert_eq!(validate_request(&settings, "model-b", "medium"), Ok(()));
        assert_eq!(
            validate_request(&settings, "model-c", "medium"),
            Err(InvokeRejection::ModelNotAllowed)
        );
        // An effort allowed for another model is not allowed for this one.
        assert_eq!(
            validate_request(&settings, "model-b", "high"),
            Err(InvokeRejection::ReasoningNotAllowed)
        );
    }

    #[test]
    fn manual_mode_refuses_every_request() {
        let mut settings = enabled(vec![profile("model-a", &["high"])]);
        settings.invoke_mode = false;
        assert_eq!(
            validate_request(&settings, "model-a", "high"),
            Err(InvokeRejection::InvokeModeDisabled)
        );
    }

    #[test]
    fn rejection_codes_serialize_as_stable_names() {
        assert_eq!(
            serde_json::to_value(InvokeRejection::ReasoningNotAllowed).expect("json"),
            json!("REASONING_NOT_ALLOWED")
        );
    }

    #[test]
    #[ignore = "requires a locally installed Codex App Server"]
    fn installed_app_server_lists_models_without_credentials() {
        let root = temp_path("catalog");
        let root = root.parent().expect("root").to_path_buf();
        let models = read_model_catalog(&root).expect("catalog");
        assert!(!models.is_empty());
        assert!(models
            .iter()
            .all(|model| !model.supported_reasoning_efforts.is_empty()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_model_catalog_pages_and_skips_hidden_models() {
        let (models, cursor) = parse_model_list(&json!({
            "data": [
                {
                    "id": "gpt-x",
                    "model": "gpt-x",
                    "displayName": "GPT X",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "serviceTiers": [{ "id": "priority", "name": "Fast" }],
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "low", "description": ""},
                        {"reasoningEffort": "max", "description": ""}
                    ]
                },
                {"id": "secret", "model": "secret", "hidden": true, "supportedReasoningEfforts": []}
            ],
            "nextCursor": "page-2"
        }))
        .expect("catalog");
        assert_eq!(cursor.as_deref(), Some("page-2"));
        assert_eq!(
            models,
            vec![CatalogModel {
                model: "gpt-x".into(),
                display_name: "GPT X".into(),
                supported_reasoning_efforts: vec!["low".into(), "max".into()],
                service_tiers: vec!["priority".into()],
                default_reasoning_effort: Some("medium".into()),
                is_default: true,
                only_on: None,
            }]
        );
        assert!(parse_model_list(&json!({"nextCursor": null})).is_err());
    }
}
