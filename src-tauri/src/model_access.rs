//! Which Codex models each saved ChatGPT account can use (added by Light505
//! for gswitchtool). Codex's own model list, read with an account's access
//! token, names for every model the plans it is available on. Reading it
//! changes nothing and never refreshes a sign-in; an account that cannot be
//! read is unknown, and unknown never blocks an account.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{
    accounts::AppState,
    chatgpt::ChatGptClient,
    quota::{
        external_credential_state_for_identity, verified_chatgpt_identity, ExternalCredentialState,
    },
    types::{AccountKind, CatalogModel},
};

/// One model from Codex's list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteModel {
    pub slug: String,
    pub display_name: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// Plans the model is available on; empty means any plan.
    pub plans: Vec<String>,
    /// Shown in Codex's model picker, as opposed to hidden helper models.
    pub listed: bool,
}

/// Reads Codex's model list response. Entries without a name are skipped.
pub fn parse_models(response: &Value) -> Vec<RemoteModel> {
    let strings = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.as_str()
                            .or_else(|| item.get("effort").and_then(Value::as_str))
                            .map(|text| text.trim().to_ascii_lowercase())
                    })
                    .filter(|text| !text.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    response
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let slug = model
                        .get("slug")
                        .and_then(Value::as_str)?
                        .trim()
                        .to_string();
                    if slug.is_empty() {
                        return None;
                    }
                    Some(RemoteModel {
                        display_name: model
                            .get("display_name")
                            .and_then(Value::as_str)
                            .unwrap_or(&slug)
                            .to_string(),
                        efforts: strings(model.get("supported_reasoning_levels")),
                        default_effort: model
                            .get("default_reasoning_level")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        plans: strings(model.get("available_in_plans")),
                        listed: model.get("visibility").and_then(Value::as_str) == Some("list"),
                        slug,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What the last read found, per saved ChatGPT account.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelAccess {
    /// Account ID to the models it can use, or `None` when unknown.
    by_account: HashMap<String, Option<HashSet<String>>>,
    /// Every listed model any account was offered, in first-seen order.
    models: Vec<RemoteModel>,
}

/// One account's input to `ModelAccess::from_lists`.
pub struct AccountModels {
    pub account_id: String,
    pub plan: Option<String>,
    /// `None` when the account's list could not be read.
    pub models: Option<Vec<RemoteModel>>,
}

impl ModelAccess {
    /// An account can use a model Codex lists for it whose plans include the
    /// account's plan.
    pub fn from_lists(accounts: Vec<AccountModels>) -> Self {
        let mut access = Self::default();
        let mut seen = HashSet::new();
        for account in accounts {
            let usable = account.models.map(|models| {
                let plan = account.plan.as_deref().map(str::to_ascii_lowercase);
                let mut usable = HashSet::new();
                for model in models.into_iter().filter(|model| model.listed) {
                    let on_plan = model.plans.is_empty()
                        || plan.as_ref().is_none_or(|plan| model.plans.contains(plan));
                    if on_plan {
                        usable.insert(model.slug.clone());
                    }
                    if seen.insert(model.slug.clone()) {
                        access.models.push(model);
                    }
                }
                usable
            });
            access.by_account.insert(account.account_id, usable);
        }
        access
    }

    /// False only when the account is known not to have the model.
    pub fn available(&self, account_id: &str, model: &str) -> bool {
        match self.by_account.get(account_id) {
            Some(Some(models)) => models.contains(model),
            _ => true,
        }
    }

    /// The accounts that can use a model, when some known account cannot.
    pub fn only_on(&self, model: &str) -> Option<Vec<String>> {
        let known = self
            .by_account
            .iter()
            .filter_map(|(id, models)| models.as_ref().map(|models| (id, models)))
            .collect::<Vec<_>>();
        if known.iter().all(|(_, models)| models.contains(model)) {
            return None;
        }
        let mut with = known
            .into_iter()
            .filter(|(_, models)| models.contains(model))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        with.sort();
        Some(with)
    }

    /// Adds each account's availability to the installed CLI's catalog, and
    /// the listed models Codex offers that the catalog does not have yet.
    pub fn annotate(&self, catalog: Vec<CatalogModel>) -> Vec<CatalogModel> {
        let mut annotated = catalog;
        for model in &self.models {
            if !annotated.iter().any(|known| known.model == model.slug) && !model.efforts.is_empty()
            {
                annotated.push(CatalogModel {
                    model: model.slug.clone(),
                    display_name: model.display_name.clone(),
                    supported_reasoning_efforts: model.efforts.clone(),
                    service_tiers: Vec::new(),
                    default_reasoning_effort: model.default_effort.clone(),
                    is_default: false,
                    only_on: None,
                });
            }
        }
        for model in &mut annotated {
            model.only_on = self.only_on(&model.model);
        }
        annotated
    }
}

/// Reads every signed-in saved ChatGPT account's model list with its current
/// access token, the way a quota refresh does: a running Codex's live token
/// for its own account, otherwise the saved one, and never a refresh.
pub fn read(state: &AppState, client_version: &str) -> ModelAccess {
    let Ok(client) = ChatGptClient::new() else {
        return ModelAccess::default();
    };
    let accounts = state.list().unwrap_or_default();
    let lists = accounts
        .into_iter()
        .filter(|account| account.kind == AccountKind::ChatGpt && !account.sign_in_required)
        .map(|view| {
            let models = state.account_by_id(&view.id).ok().and_then(|account| {
                let identity = verified_chatgpt_identity(&account).ok()?;
                let credential = match external_credential_state_for_identity(&identity).ok()? {
                    ExternalCredentialState::Matching(credential) => credential,
                    ExternalCredentialState::Unidentifiable => return None,
                    _ => account.credential.clone(),
                };
                client
                    .models(&credential, client_version)
                    .ok()
                    .map(|response| parse_models(&response))
            });
            AccountModels {
                account_id: view.id,
                plan: view.plan_type,
                models,
            }
        })
        .collect();
    ModelAccess::from_lists(lists)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(slug: &str, plans: &[&str]) -> RemoteModel {
        RemoteModel {
            slug: slug.into(),
            display_name: slug.into(),
            efforts: vec!["low".into(), "high".into()],
            default_effort: Some("low".into()),
            plans: plans.iter().map(|plan| plan.to_string()).collect(),
            listed: true,
        }
    }

    fn account(id: &str, plan: &str, models: Option<Vec<RemoteModel>>) -> AccountModels {
        AccountModels {
            account_id: id.into(),
            plan: Some(plan.into()),
            models,
        }
    }

    /// Needs a signed-in Codex. Run with `--ignored`; it reads the live
    /// account's model list once and changes nothing.
    #[test]
    #[ignore]
    fn the_live_sign_in_reads_codexs_model_list() {
        let home = crate::codex::codex_home().expect("codex home");
        let credential = crate::codex::read_optional_auth_document(&home)
            .expect("auth")
            .expect("signed in");
        let response = ChatGptClient::new()
            .expect("client")
            .models(&credential, &crate::commands::codex_client_version())
            .expect("model list");
        let models = parse_models(&response);
        assert!(models
            .iter()
            .any(|model| model.listed && !model.efforts.is_empty()));
        assert!(models.iter().any(|model| !model.plans.is_empty()));
    }

    #[test]
    fn reads_codexs_model_list_with_plans_and_efforts() {
        let parsed = parse_models(&json!({ "models": [
            {
                "slug": "gpt-7-pro", "display_name": "GPT-7 Pro", "visibility": "list",
                "default_reasoning_level": "high",
                "supported_reasoning_levels": [{ "effort": "high", "description": "x" }, { "effort": "MAX" }],
                "available_in_plans": ["pro", "enterprise"]
            },
            { "slug": "helper", "visibility": "hide", "supported_reasoning_levels": [] },
            { "display_name": "no slug" }
        ]}));
        assert_eq!(
            parsed,
            vec![
                RemoteModel {
                    slug: "gpt-7-pro".into(),
                    display_name: "GPT-7 Pro".into(),
                    efforts: vec!["high".into(), "max".into()],
                    default_effort: Some("high".into()),
                    plans: vec!["pro".into(), "enterprise".into()],
                    listed: true,
                },
                RemoteModel {
                    slug: "helper".into(),
                    display_name: "helper".into(),
                    efforts: Vec::new(),
                    default_effort: None,
                    plans: Vec::new(),
                    listed: false,
                },
            ]
        );
        assert!(parse_models(&json!({ "unexpected": true })).is_empty());
    }

    #[test]
    fn a_model_on_some_plans_is_only_on_the_accounts_with_those_plans() {
        let everywhere = model("gpt-6-sol", &["free", "plus", "pro"]);
        let pro_only = model("gpt-7-pro", &["pro"]);
        let access = ModelAccess::from_lists(vec![
            // A Plus account may still be shown the Pro model in its list.
            account(
                "plus-1",
                "plus",
                Some(vec![everywhere.clone(), pro_only.clone()]),
            ),
            account(
                "pro-1",
                "pro",
                Some(vec![everywhere.clone(), pro_only.clone()]),
            ),
            account("unread", "plus", None),
        ]);
        assert!(access.available("pro-1", "gpt-7-pro"));
        assert!(!access.available("plus-1", "gpt-7-pro"));
        // Unknown accounts and accounts never read are never blocked.
        assert!(access.available("unread", "gpt-7-pro"));
        assert!(access.available("missing", "gpt-7-pro"));
        assert_eq!(access.only_on("gpt-7-pro"), Some(vec!["pro-1".to_string()]));
        assert_eq!(access.only_on("gpt-6-sol"), None);

        // A model missing from an account's list is not available there.
        let access = ModelAccess::from_lists(vec![
            account("plus-1", "plus", Some(vec![everywhere.clone()])),
            account("pro-1", "pro", Some(vec![everywhere, pro_only])),
        ]);
        assert_eq!(access.only_on("gpt-7-pro"), Some(vec!["pro-1".to_string()]));
    }

    #[test]
    fn the_catalog_gains_new_listed_models_and_marks_exclusive_ones() {
        let access = ModelAccess::from_lists(vec![
            account(
                "plus-1",
                "plus",
                Some(vec![model("gpt-6-sol", &[]), model("gpt-7-pro", &["pro"])]),
            ),
            account(
                "pro-1",
                "pro",
                Some(vec![model("gpt-6-sol", &[]), model("gpt-7-pro", &["pro"])]),
            ),
        ]);
        let installed = vec![CatalogModel {
            model: "gpt-6-sol".into(),
            display_name: "GPT-6 Sol".into(),
            supported_reasoning_efforts: vec!["low".into()],
            service_tiers: Vec::new(),
            default_reasoning_effort: None,
            is_default: true,
            only_on: None,
        }];
        let annotated = access.annotate(installed);
        assert_eq!(annotated.len(), 2);
        assert_eq!(
            annotated[0].supported_reasoning_efforts,
            vec!["low".to_string()]
        );
        assert_eq!(annotated[0].only_on, None);
        assert_eq!(annotated[1].model, "gpt-7-pro");
        assert_eq!(annotated[1].only_on, Some(vec!["pro-1".to_string()]));
        assert!(!annotated[1].is_default);
    }
}
