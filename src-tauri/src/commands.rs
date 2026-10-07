use std::sync::Arc;

use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    accounts::AppState,
    app_update::{self, AppUpdateFailure, AppUpdateView, DownloadEvent},
    cli_update, codex,
    failover::{Coordinator, InvokePause, SwitchAccounts},
    intake,
    invoke::{self, InvokeState},
    migration, quota, switching,
    types::{
        AccountView, AppSnapshot, CatalogModel, CodexCliInfo, CodexCliUpdateFailure,
        CodexCliUpdateStatus, ExportResult, ImportResult, InvocationProfile, InvokeSettings,
        LiveAccountView, MigrationPreview, OAuthLoginStart, OAuthLoginStatus, QuotaRefreshFailure,
        QuotaRefreshFailureCode, QuotaView, ResetCreditFailure, ResetCreditFailureCode,
        ResetCreditOutcome, RuntimeInfo, StorageStatus, SwitchFailure, SwitchFailureCode,
        SwitchOutcome, UpdateDelivery, WakeOperationView, WakeStart,
    },
    wake,
};

/// Keeps Tauri's command runtime available for the WebView while the existing
/// synchronous domain layer performs filesystem, provider, process, or App
/// Server work. Credential-operation serialization remains owned by AppState.
async fn run_blocking<T>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "A GSwitch background operation stopped unexpectedly".to_string())?
}

#[tauri::command]
pub async fn get_runtime_info() -> Result<RuntimeInfo, String> {
    run_blocking(codex::runtime_info).await
}

#[tauri::command]
pub async fn get_codex_cli_info() -> CodexCliInfo {
    tauri::async_runtime::spawn_blocking(cli_update::check_latest)
        .await
        .unwrap_or(CodexCliInfo {
            version: None,
            supports_update: false,
            latest_version: None,
            update_status: CodexCliUpdateStatus::Unknown,
        })
}

#[tauri::command]
pub async fn update_codex_cli(
    state: State<'_, AppState>,
) -> Result<CodexCliInfo, CodexCliUpdateFailure> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cli_update::update(&state))
        .await
        .map_err(|_| CodexCliUpdateFailure::UpdateFailed)?
}

#[tauri::command]
pub fn open_codex_cli_guide(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://developers.openai.com/codex/cli/", None::<&str>)
        .map_err(|_| "Unable to open the official Codex CLI guide".to_string())
}

/// Supplies one credential-free initial workspace projection. When GSwitch's
/// own account store is damaged, this deliberately
/// avoids touching Codex configuration or credentials so the recovery screen
/// can still open safely.
#[tauri::command]
pub async fn get_app_snapshot(state: State<'_, AppState>) -> Result<AppSnapshot, String> {
    let state = state.inner().clone();
    run_blocking(move || app_snapshot(&state)).await
}

fn app_snapshot(state: &AppState) -> Result<AppSnapshot, String> {
    let storage = state.storage_view();
    if storage.status == StorageStatus::RecoveryRequired {
        return Ok(AppSnapshot {
            storage,
            accounts: Vec::new(),
            pending_reset: None,
            runtime: None,
            live: None,
        });
    }

    Ok(AppSnapshot {
        storage,
        accounts: state.list()?,
        pending_reset: state.pending_reset_view()?,
        runtime: Some(codex::runtime_info()?),
        live: Some(switching::live_account(state)?),
    })
}

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> Result<Vec<AccountView>, String> {
    let state = state.inner().clone();
    run_blocking(move || state.list()).await
}

#[tauri::command]
pub async fn reset_damaged_account_store(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    run_blocking(move || state.reset_damaged_store()).await
}

/// Explicit recovery action. Only a count returns to the WebView; the vault
/// index, credential document, and stable identity stay inside Rust.
#[tauri::command]
pub async fn recover_pending_credentials(state: State<'_, AppState>) -> Result<u32, String> {
    let state = state.inner().clone();
    run_blocking(move || state.recover_pending_credentials()).await
}

#[tauri::command]
pub async fn start_oauth_login(
    state: State<'_, AppState>,
    target_id: Option<String>,
) -> Result<OAuthLoginStart, String> {
    let state = state.inner().clone();
    run_blocking(move || intake::start_oauth(state, target_id)).await
}

#[tauri::command]
pub fn get_oauth_login_status(
    state: State<'_, AppState>,
    login_id: String,
) -> Result<OAuthLoginStatus, String> {
    state.oauth_status(&login_id)
}

#[tauri::command]
pub async fn retry_oauth_login(state: State<'_, AppState>, login_id: String) -> Result<(), String> {
    let state = state.inner().clone();
    run_blocking(move || intake::retry_oauth(state, login_id)).await
}

#[tauri::command]
pub fn cancel_oauth_login(state: State<'_, AppState>, login_id: String) -> Result<(), String> {
    intake::cancel_oauth(state.inner(), &login_id)
}

#[tauri::command]
pub fn open_oauth_login(
    app: AppHandle,
    state: State<'_, AppState>,
    login_id: String,
) -> Result<(), String> {
    let url = state.oauth_url(&login_id)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|_| "Unable to open the OAuth URL in your browser".to_string())
}

#[tauri::command]
pub fn get_update_delivery() -> UpdateDelivery {
    update_delivery_for(std::env::consts::OS, std::env::var_os("APPIMAGE").is_some())
}

#[tauri::command]
pub fn open_latest_release(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(
            "https://github.com/Light505/gswitchtool/releases/latest",
            None::<&str>,
        )
        .map_err(|_| "Unable to open the GSwitch release page in your browser".to_string())
}

/// Saves how much of each account's weekly window automatic choices leave.
#[tauri::command]
pub fn set_invoke_weekly_reserve(
    invoke: State<'_, InvokeState>,
    reserve: std::collections::BTreeMap<String, u8>,
) -> Result<InvokeSettings, String> {
    invoke.set_weekly_reserve(reserve)
}

/// Saves per-kind task suggestions inside the current model/effort whitelist.
#[tauri::command]
pub fn set_invoke_task_defaults(
    invoke: State<'_, InvokeState>,
    task_defaults: std::collections::BTreeMap<String, crate::types::InvocationDefault>,
) -> Result<InvokeSettings, String> {
    invoke.set_task_defaults(task_defaults)
}

/// Codex tasks Claude delegated that are running or waiting their turn.
#[tauri::command]
pub fn get_invoke_tasks(
    coordinator: State<'_, Arc<Coordinator>>,
) -> Vec<crate::failover::WorkerView> {
    coordinator.workers()
}

/// The user stops one delegated Codex task.
#[tauri::command]
pub fn stop_invoke_task(
    coordinator: State<'_, Arc<Coordinator>>,
    id: String,
) -> Result<(), String> {
    coordinator
        .stop_task(&id)
        .map_err(|_| "That Codex task has already finished".to_string())
}

/// The threads that were running when Invoke Mode paused.
#[tauri::command]
pub fn get_paused_threads(
    coordinator: State<'_, Arc<Coordinator>>,
) -> Vec<crate::failover::PausedThread> {
    coordinator.paused_threads()
}

/// The new steps of a delegated Codex task's thread, read from Codex's own
/// session file from `offset`, for the live view.
#[tauri::command]
pub fn read_task_log(thread_id: String, offset: u64) -> crate::task_log::LogChunk {
    match crate::codex::codex_home() {
        Ok(home) => crate::task_log::read(&home, &thread_id, offset),
        Err(_) => crate::task_log::LogChunk {
            found: false,
            items: Vec::new(),
            offset,
        },
    }
}

/// The newest Invoke Mode activity, newest first.
#[tauri::command]
pub fn get_activity(
    activity: State<'_, Arc<crate::activity::ActivityLog>>,
    limit: Option<usize>,
) -> Vec<crate::activity::ActivityEntry> {
    activity.recent(limit.unwrap_or(200).min(1000))
}

/// The running app's version, shown next to its name.
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> crate::types::AppVersion {
    crate::types::AppVersion {
        version: app.package_info().version.to_string(),
        dev: crate::build_identity::is_dev_identifier(&app.config().identifier),
    }
}

/// Looks for a newer installed-app release. The user decides whether to install it.
#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<Option<AppUpdateView>, AppUpdateFailure> {
    app_update::check(&app).await
}

/// Installs the update the user agreed to, unless Claude's delegated Codex
/// work is running, which the restart would stop.
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    coordinator: State<'_, Arc<Coordinator>>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), AppUpdateFailure> {
    let (running, failover) = coordinator.status();
    app_update::install(&app, running > 0 || failover, on_event).await
}

fn update_delivery_for(os: &str, appimage: bool) -> UpdateDelivery {
    match os {
        "windows" => UpdateDelivery::InstallerExits,
        "macos" => UpdateDelivery::RelaunchRequired,
        "linux" if appimage => UpdateDelivery::RelaunchRequired,
        "linux" => UpdateDelivery::ReleaseDownload,
        _ => UpdateDelivery::ReleaseDownload,
    }
}

#[tauri::command]
pub async fn import_auth_json(
    state: State<'_, AppState>,
    raw_json: String,
    label: Option<String>,
) -> Result<AccountView, String> {
    let state = state.inner().clone();
    run_blocking(move || intake::import_json(&state, &raw_json, label)).await
}

#[tauri::command]
pub async fn import_auth_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportResult, String> {
    let state = state.inner().clone();
    run_blocking(move || intake::import_file(&state, &path)).await
}

#[tauri::command]
pub async fn import_auth_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<ImportResult, String> {
    let state = state.inner().clone();
    run_blocking(move || intake::import_files(&state, paths)).await
}

#[tauri::command]
pub async fn export_accounts(
    app: AppHandle,
    state: State<'_, AppState>,
    selected_ids: Vec<String>,
) -> Result<ExportResult, String> {
    let state = state.inner().clone();
    let export =
        run_blocking(move || intake::prepare_accounts_export(&state, selected_ids)).await?;
    let destination = app
        .dialog()
        .file()
        .set_title("Export GSwitch accounts")
        .set_file_name("gswitch-accounts.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .map(|destination| {
            destination
                .into_path()
                .map_err(|_| "Unable to use the selected export location".to_string())
        })
        .transpose()?;
    run_blocking(move || intake::complete_accounts_export(&export, destination.as_deref())).await
}

#[tauri::command]
pub async fn discover_local_accounts(
    state: State<'_, AppState>,
    custom_root: Option<String>,
) -> Result<MigrationPreview, String> {
    let state = state.inner().clone();
    run_blocking(move || migration::discover(&state, custom_root)).await
}

#[tauri::command]
pub async fn import_local_accounts(
    state: State<'_, AppState>,
    custom_root: Option<String>,
    selected_ids: Vec<String>,
) -> Result<ImportResult, String> {
    let state = state.inner().clone();
    run_blocking(move || migration::confirm(&state, custom_root, selected_ids)).await
}

#[tauri::command]
pub async fn import_api_key(
    state: State<'_, AppState>,
    api_key: String,
    label: Option<String>,
) -> Result<AccountView, String> {
    let state = state.inner().clone();
    run_blocking(move || intake::import_api_key(&state, &api_key, label)).await
}

#[tauri::command]
pub async fn get_live_account_state(state: State<'_, AppState>) -> Result<LiveAccountView, String> {
    let state = state.inner().clone();
    run_blocking(move || switching::live_account(&state)).await
}

#[tauri::command]
pub async fn save_current_account(state: State<'_, AppState>) -> Result<AccountView, String> {
    let state = state.inner().clone();
    run_blocking(move || switching::save_current_account(&state)).await
}

#[tauri::command]
pub async fn enable_account_switching(state: State<'_, AppState>) -> Result<bool, String> {
    let state = state.inner().clone();
    run_blocking(move || switching::enable_file_store(&state)).await
}

#[tauri::command]
pub async fn switch_account(
    state: State<'_, AppState>,
    target_id: String,
) -> Result<SwitchOutcome, SwitchFailure> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let attempted_generation = state
            .account_by_id(&target_id)
            .ok()
            .map(|account| account.credential_generation);
        let result = switching::switch_account(&state, &target_id);
        if result
            .as_ref()
            .is_err_and(|failure| failure.code == SwitchFailureCode::AccountNeedsSignIn)
        {
            if let (Some(generation), Ok(operation)) =
                (attempted_generation, state.acquire_quota_commit_operation())
            {
                let _ = state.mark_sign_in_required(&operation, &target_id, generation);
            }
        }
        result
    })
    .await
    .map_err(|_| SwitchFailure {
        code: SwitchFailureCode::VerificationFailed,
    })?
}

#[tauri::command]
pub async fn recover_pending_switch(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    run_blocking(move || switching::recover_pending_switch(&state)).await
}

#[tauri::command]
pub async fn remove_saved_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let state = state.inner().clone();
    run_blocking(move || switching::remove_saved_account(&state, &id)).await
}

#[tauri::command]
pub async fn get_account_quota(
    state: State<'_, AppState>,
    id: String,
) -> Result<QuotaView, String> {
    let state = state.inner().clone();
    run_blocking(move || quota::cached_quota(&state, &id)).await
}

#[tauri::command]
pub async fn refresh_account_quota(
    state: State<'_, AppState>,
    id: String,
    background: bool,
) -> Result<QuotaView, QuotaRefreshFailure> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let attempted_generation = state
            .account_by_id(&id)
            .ok()
            .map(|account| account.credential_generation);
        let result = if background {
            quota::refresh_quota_background(&state, &id)
        } else {
            quota::refresh_quota(&state, &id)
        };
        if result.as_ref().is_err_and(|error| {
            quota::refresh_failure(error).code == QuotaRefreshFailureCode::Authentication
        }) {
            if let (Some(generation), Ok(operation)) =
                (attempted_generation, state.acquire_quota_commit_operation())
            {
                let _ = state.mark_sign_in_required(&operation, &id, generation);
            }
        }
        result
    })
    .await
    .map_err(|_| QuotaRefreshFailure {
        code: QuotaRefreshFailureCode::Unavailable,
    })?
    .map_err(|error| quota::refresh_failure(&error))
}

#[tauri::command]
pub async fn redeem_reset_credit(
    state: State<'_, AppState>,
    id: String,
    expires_at: Option<i64>,
    granted_at: Option<i64>,
) -> Result<ResetCreditOutcome, ResetCreditFailure> {
    let state = state.inner().clone();
    let choice = quota::ResetCreditChoice {
        expires_at,
        granted_at,
    };
    run_reset_blocking(move || quota::redeem_reset_credit(&state, &id, choice)).await
}

/// A stopped worker cannot say whether the consume request was sent, so its
/// outcome is unknown; any pending record stays for recovery.
async fn run_reset_blocking(
    task: impl FnOnce() -> Result<ResetCreditOutcome, ResetCreditFailure> + Send + 'static,
) -> Result<ResetCreditOutcome, ResetCreditFailure> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| ResetCreditFailure {
            code: ResetCreditFailureCode::ResultUnknown,
        })?
}

#[tauri::command]
pub async fn discard_pending_reset_credit(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    run_blocking(move || quota::discard_pending_reset_credit(&state)).await
}

#[tauri::command]
pub async fn recover_pending_reset_credit(
    state: State<'_, AppState>,
) -> Result<ResetCreditOutcome, ResetCreditFailure> {
    let state = state.inner().clone();
    run_reset_blocking(move || quota::recover_pending_reset_credit(&state)).await
}

#[tauri::command]
pub fn start_wake(
    state: State<'_, AppState>,
    id: String,
    alternate_model: bool,
) -> Result<WakeStart, String> {
    wake::start_one(state.inner().clone(), id, alternate_model)
}

#[tauri::command]
pub fn start_wake_all(state: State<'_, AppState>) -> Result<WakeStart, String> {
    wake::start_all(state.inner().clone())
}

#[tauri::command]
pub fn start_wake_selected(
    state: State<'_, AppState>,
    selected_ids: Vec<String>,
) -> Result<WakeStart, String> {
    wake::start_selected(state.inner().clone(), selected_ids)
}

#[tauri::command]
pub fn get_wake_operation(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<WakeOperationView, String> {
    wake::operation(state.inner(), &operation_id)
}

#[tauri::command]
pub fn get_invoke_settings(invoke: State<'_, InvokeState>) -> Result<InvokeSettings, String> {
    invoke.settings()
}

/// The Invoke Mode switch waiting for the user to close Codex, if any.
#[tauri::command]
pub fn get_invoke_failover(coordinator: State<'_, Arc<Coordinator>>) -> Option<SwitchAccounts> {
    coordinator.waiting_for_codex()
}

/// Ends a waiting Invoke Mode switch without changing accounts.
#[tauri::command]
pub fn cancel_invoke_failover(coordinator: State<'_, Arc<Coordinator>>) {
    coordinator.cancel_waiting_failover();
}

/// Why Invoke Mode starts no Codex work, if it is paused.
#[tauri::command]
pub fn get_invoke_pause(coordinator: State<'_, Arc<Coordinator>>) -> Option<InvokePause> {
    coordinator.pause()
}

/// The user lets Invoke Mode start Codex work again before the reset time.
#[tauri::command]
pub fn resume_invoke(coordinator: State<'_, Arc<Coordinator>>) {
    coordinator.resume();
}

/// Turning Invoke Mode on or off also ends a pause: the user has decided.
#[tauri::command]
pub fn set_invoke_mode(
    invoke: State<'_, InvokeState>,
    coordinator: State<'_, Arc<Coordinator>>,
    enabled: bool,
) -> Result<InvokeSettings, String> {
    let settings = invoke.set_invoke_mode(enabled)?;
    coordinator.resume();
    Ok(settings)
}

/// Reads the installed Codex model catalog. Starting App Server takes the
/// operation lock so it cannot overlap a Codex CLI update.
#[tauri::command]
pub async fn get_model_catalog(
    state: State<'_, AppState>,
    invoke: State<'_, InvokeState>,
    refresh: bool,
) -> Result<Vec<CatalogModel>, String> {
    if !refresh {
        if let Some(catalog) = invoke.cached_catalog() {
            return Ok(catalog);
        }
    }
    let state = state.inner().clone();
    let invoke = invoke.inner().clone();
    run_blocking(move || read_and_remember_catalog(&state, &invoke)).await
}

#[tauri::command]
pub async fn set_invoke_profiles(
    state: State<'_, AppState>,
    invoke: State<'_, InvokeState>,
    profiles: Vec<InvocationProfile>,
) -> Result<InvokeSettings, String> {
    let state = state.inner().clone();
    let invoke = invoke.inner().clone();
    run_blocking(move || {
        let catalog = match invoke.cached_catalog() {
            Some(catalog) => catalog,
            None => read_and_remember_catalog(&state, &invoke)?,
        };
        invoke.set_profiles(&profiles, &catalog)
    })
    .await
}

/// Saves the account order, the usage a preferred account must have left, and
/// how many Codex tasks may run at once.
#[tauri::command]
pub fn set_invoke_preferences(
    invoke: State<'_, InvokeState>,
    account_priority: Vec<String>,
    preferred_min_remaining: u8,
    max_concurrent_tasks: u8,
    auto_wake: bool,
) -> Result<InvokeSettings, String> {
    invoke.set_preferences(
        account_priority,
        preferred_min_remaining,
        max_concurrent_tasks,
        auto_wake,
    )
}

#[tauri::command]
pub async fn set_account_invoke_allowed(
    state: State<'_, AppState>,
    coordinator: State<'_, Arc<Coordinator>>,
    id: String,
    allowed: bool,
) -> Result<AccountView, String> {
    let state = state.inner().clone();
    let account = run_blocking(move || state.set_invoke_allowed(&id, allowed)).await?;
    // Allowing another account may give Invoke Mode usage to continue with.
    if allowed {
        coordinator.resume();
    }
    Ok(account)
}

fn read_and_remember_catalog(
    state: &AppState,
    invoke: &InvokeState,
) -> Result<Vec<CatalogModel>, String> {
    let installed = {
        let _operation = state.acquire_operation()?;
        invoke::read_model_catalog(&state.isolated_profile_root()?)?
    };
    // Which accounts can use each model; read after the operation lock is
    // released, like an automatic quota refresh.
    let access = crate::model_access::read(state, &codex_client_version());
    let catalog = access.annotate(installed);
    invoke.remember_model_access(access);
    invoke.remember_catalog(catalog.clone());
    Ok(catalog)
}

/// The installed Codex CLI's version, which Codex's model list is filtered by.
pub(crate) fn codex_client_version() -> String {
    crate::cli_update::inspect()
        .version
        .unwrap_or_else(|| "0.0.0".to_string())
}

#[tauri::command]
pub fn cancel_wake(state: State<'_, AppState>, operation_id: String) -> Result<(), String> {
    wake::cancel(state.inner(), &operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn delayed_domain_work_runs_away_from_the_command_thread() {
        let command_thread = thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(run_blocking(|| {
            thread::sleep(Duration::from_millis(10));
            Ok(thread::current().id())
        }))
        .expect("background task should complete");

        assert_ne!(worker_thread, command_thread);
    }

    #[test]
    fn update_delivery_requires_a_manual_download_for_debian_packages() {
        assert_eq!(
            update_delivery_for("linux", false),
            UpdateDelivery::ReleaseDownload
        );
        assert_eq!(
            update_delivery_for("linux", true),
            UpdateDelivery::RelaunchRequired
        );
        assert_eq!(
            update_delivery_for("windows", false),
            UpdateDelivery::InstallerExits
        );
        assert_eq!(
            update_delivery_for("macos", false),
            UpdateDelivery::RelaunchRequired
        );
    }
}
