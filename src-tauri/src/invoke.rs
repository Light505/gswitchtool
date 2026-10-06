//! Human-owned Invoke Mode policy: whether Claude Code may delegate work to
//! Codex, and which Codex model/reasoning-effort combinations it may request.
//! The WebView commands are the only writers; request validation is read-only.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};

use crate::{
    app_server::{AppServer, TempCodexHome},
    storage,
    types::{CatalogModel, InvocationProfile, InvokeSettings},
};

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
}

impl InvokeState {
    /// A missing or unreadable policy file starts with Invoke Mode off. The
    /// file holds no credentials, so the next human change rewrites it.
    pub fn load(path: PathBuf) -> Self {
        let settings = match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(error) if error.kind() == ErrorKind::NotFound => InvokeSettings::default(),
            Err(_) => InvokeSettings::default(),
        };
        Self {
            path: Arc::new(path),
            settings: Arc::new(Mutex::new(settings)),
            catalog: Arc::new(Mutex::new(None)),
        }
    }

    pub fn settings(&self) -> Result<InvokeSettings, String> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "Invoke Mode settings are unavailable".to_string())
    }

    pub fn set_invoke_mode(&self, enabled: bool) -> Result<InvokeSettings, String> {
        self.update(|settings| settings.invoke_mode = enabled)
    }

    /// Replaces the whitelist after checking it against `catalog`, which must
    /// come from the installed Codex App Server.
    pub fn set_profiles(
        &self,
        requested: &[InvocationProfile],
        catalog: &[CatalogModel],
    ) -> Result<InvokeSettings, String> {
        let profiles = normalize_profiles(requested, catalog)?;
        self.update(|settings| settings.allowed_invocation_profiles = profiles)
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

    pub fn remember_catalog(&self, models: Vec<CatalogModel>) {
        if let Ok(mut catalog) = self.catalog.lock() {
            *catalog = Some(models);
        }
    }

    fn update<F>(&self, change: F) -> Result<InvokeSettings, String>
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
        *settings = candidate.clone();
        Ok(candidate)
    }
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
                default_reasoning_effort: entry
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                is_default: entry
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("gswitch-invoke-{name}-{suffix}"))
            .join("invoke.json")
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
                default_reasoning_effort: Some("medium".into()),
                is_default: true,
            },
            CatalogModel {
                model: "model-b".into(),
                display_name: "Model B".into(),
                supported_reasoning_efforts: vec!["low".into(), "medium".into()],
                default_reasoning_effort: None,
                is_default: false,
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
            allowed_invocation_profiles: profiles,
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
                default_reasoning_effort: Some("medium".into()),
                is_default: true,
            }]
        );
        assert!(parse_model_list(&json!({"nextCursor": null})).is_err());
    }
}
