mod accounts;
mod app_server;
mod chatgpt;
mod cli_update;
mod codex;
mod commands;
mod failover;
mod identity;
mod intake;
mod invoke;
mod invoke_ipc;
mod migration;
mod quota;
mod runtime;
mod storage;
mod switching;
mod types;
mod vault;
mod wake;

use std::sync::Arc;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first, as the plugin requires. Each GSwitch process keeps
        // its own in-memory account store, so a second launch only brings the
        // running window forward instead of starting another process.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let state = accounts::AppState::new(config_dir.join("accounts.json"))
                .map_err(std::io::Error::other)?;
            app.manage(state.clone());
            let invoke = invoke::InvokeState::load(config_dir.join("invoke.json"));
            let handle = app.handle().clone();
            let coordinator = failover::Coordinator::new(
                Arc::new(failover::AppOps {
                    state,
                    invoke: invoke.clone(),
                    // The window reloads its accounts and names both accounts.
                    on_switched: Box::new(move |from, to| {
                        let _ = handle.emit(
                            "invoke-account-switched",
                            serde_json::json!({ "from": from, "to": to }),
                        );
                    }),
                }),
                failover::Timings::default(),
            );
            // Without the endpoint Claude Code cannot delegate, but Manual
            // Mode and every account action keep working.
            let _ = invoke_ipc::start(&config_dir, invoke.clone(), coordinator);
            app.manage(invoke);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_info,
            commands::get_codex_cli_info,
            commands::update_codex_cli,
            commands::open_codex_cli_guide,
            commands::get_app_snapshot,
            commands::list_accounts,
            commands::reset_damaged_account_store,
            commands::recover_pending_credentials,
            commands::start_oauth_login,
            commands::get_oauth_login_status,
            commands::retry_oauth_login,
            commands::cancel_oauth_login,
            commands::open_oauth_login,
            commands::get_update_delivery,
            commands::open_latest_release,
            commands::import_auth_json,
            commands::import_auth_file,
            commands::import_auth_files,
            commands::export_accounts,
            commands::discover_local_accounts,
            commands::import_local_accounts,
            commands::import_api_key,
            commands::get_live_account_state,
            commands::save_current_account,
            commands::enable_account_switching,
            commands::switch_account,
            commands::recover_pending_switch,
            commands::remove_saved_account,
            commands::get_account_quota,
            commands::refresh_account_quota,
            commands::redeem_reset_credit,
            commands::recover_pending_reset_credit,
            commands::discard_pending_reset_credit,
            commands::start_wake,
            commands::start_wake_all,
            commands::start_wake_selected,
            commands::get_wake_operation,
            commands::cancel_wake,
            commands::get_invoke_settings,
            commands::set_invoke_mode,
            commands::get_model_catalog,
            commands::set_invoke_profiles,
            commands::set_account_invoke_allowed
        ])
        .run(tauri::generate_context!())
        .expect("error while running GSwitch");
}
