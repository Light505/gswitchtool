mod accounts;
mod activity;
mod app_server;
mod app_update;
mod auto_wake;
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
mod model_access;
mod quota;
mod runtime;
mod storage;
mod switching;
mod types;
mod vault;
mod wake;

use std::{path::PathBuf, sync::Arc};

use tauri::{Emitter, Manager};

/// The installed build's identifier. Only it updates itself; before 1.1.2 its
/// AppData folder held the data that `~/.gswitchtool` now adopts.
const SHARED_DATA_IDENTIFIER: &str = "com.light505.gswitchtool";

/// Every build keeps its accounts and settings in `~/.gswitchtool`, so the
/// installed and dev builds share them and `storage::acquire_app_instance`
/// keeps them from running at the same time. Not AppData: Windows gives an app
/// started from a packaged app, such as Claude's desktop app, its own private
/// copy of AppData, which split the accounts between launches.
const DATA_DIR_NAME: &str = ".gswitchtool";

/// Records each startup step with its time in `startup.log`, replaced on
/// every start. It holds no account data; it shows where a start stopped.
struct StartupTrace(Option<std::fs::File>);

impl StartupTrace {
    fn create(dir: &std::path::Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self(std::fs::File::create(dir.join("startup.log")).ok())
    }

    fn step(&mut self, step: &str) {
        use std::io::Write;
        if let Some(file) = &mut self.0 {
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or_default();
            let _ = writeln!(file, "{millis} pid {} {step}", std::process::id());
            let _ = file.sync_data();
        }
    }
}

/// The AppData folder that held the data before 1.1.2.
fn legacy_data_dir(own_config_dir: PathBuf) -> PathBuf {
    match own_config_dir.parent() {
        Some(parent) => parent.join(SHARED_DATA_IDENTIFIER),
        None => own_config_dir,
    }
}

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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_dir = storage::adopt_data_dir(
                &legacy_data_dir(app.path().app_config_dir()?),
                &app.path().home_dir()?.join(DATA_DIR_NAME),
            );
            let name = app.package_info().name.clone();
            match storage::acquire_app_instance(&config_dir, &name)
                .map_err(std::io::Error::other)?
            {
                storage::AppInstance::Acquired(lock) => {
                    app.manage(lock);
                }
                storage::AppInstance::HeldBy(running) => {
                    let running = running.unwrap_or_else(|| "Another GSwitch Claude Tool".into());
                    rfd::MessageDialog::new()
                        .set_level(rfd::MessageLevel::Info)
                        .set_title(&name)
                        .set_description(format!(
                            "{running} is already open. Close it before opening {name}; \
                             both use the same accounts and settings."
                        ))
                        .set_buttons(rfd::MessageButtons::Ok)
                        .show();
                    std::process::exit(0);
                }
            }
            // Only the build holding the instance lock may replace the trace.
            let mut trace = StartupTrace::create(&config_dir);
            trace.step(&format!("{name} {} started", app.package_info().version));
            app.manage(app_update::AppUpdateState::default());
            trace.step("loading accounts");
            let state = accounts::AppState::new(config_dir.join("accounts.json"))
                .map_err(std::io::Error::other)?;
            trace.step(if state.recovery_required() {
                "accounts unavailable: protected storage could not be opened"
            } else {
                "accounts loaded"
            });
            app.manage(state.clone());
            let invoke = invoke::InvokeState::load(config_dir.join("invoke.json"));
            let switched = app.handle().clone();
            let waiting = app.handle().clone();
            let paused = app.handle().clone();
            let resumed = app.handle().clone();
            let recorded = app.handle().clone();
            // What Invoke Mode did, for the Activity window.
            let activity = Arc::new(activity::ActivityLog::new(
                config_dir.join("activity.jsonl"),
                Some(Box::new(move |entry| {
                    let _ = recorded.emit("invoke-activity", entry);
                })),
            ));
            app.manage(activity.clone());
            let coordinator = failover::Coordinator::new(
                Arc::new(failover::AppOps {
                    state,
                    invoke: invoke.clone(),
                    // The window reloads its accounts and names both accounts.
                    on_switched: Box::new(move |from, to, reason| {
                        let _ = switched.emit(
                            "invoke-account-switched",
                            serde_json::json!({ "from": from, "to": to, "reason": reason }),
                        );
                    }),
                    // A switch blocked by a Codex the user opened asks the user
                    // to close it, as a manual switch would.
                    on_waiting: Box::new(move |accounts| {
                        let _ = waiting.emit("invoke-failover-waiting", accounts);
                        if accounts.is_some() {
                            if let Some(window) = waiting.get_webview_window("main") {
                                let _ = window.request_user_attention(Some(
                                    tauri::UserAttentionType::Critical,
                                ));
                            }
                        }
                    }),
                    // Every allowed account ran out of Codex usage.
                    on_paused: Box::new(move |pause| {
                        let _ = paused.emit("invoke-paused", pause);
                        if pause.is_some() {
                            if let Some(window) = paused.get_webview_window("main") {
                                let _ = window.request_user_attention(Some(
                                    tauri::UserAttentionType::Critical,
                                ));
                            }
                        }
                    }),
                    // Usage is back: say which threads can continue. At the
                    // reset time the user may be away, so Windows says it too.
                    on_resumed: Box::new(move |threads, by_user| {
                        let _ = resumed.emit(
                            "invoke-resumed",
                            serde_json::json!({ "threads": threads, "by_user": by_user }),
                        );
                        if !by_user {
                            use tauri_plugin_notification::NotificationExt;
                            let body = if threads.is_empty() {
                                "Codex usage is available again. Claude can delegate to Codex.".to_string()
                            } else {
                                format!(
                                    "Codex usage is available again. Tell Claude to continue {} paused Codex thread{}.",
                                    threads.len(),
                                    if threads.len() == 1 { "" } else { "s" }
                                )
                            };
                            let _ = resumed
                                .notification()
                                .builder()
                                .title("GSwitch Claude Tool: Invoke Mode resumed")
                                .body(body)
                                .show();
                        }
                    }),
                    activity: activity.clone(),
                }),
                failover::Timings::default(),
            );
            // A pause ends by itself at the reset time; notice it.
            {
                let coordinator = coordinator.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(30));
                    coordinator.announce_expired_pause();
                });
            }
            // Without the endpoint Claude Code cannot delegate, but Manual
            // Mode and every account action keep working.
            let endpoint = invoke_ipc::start(&config_dir, invoke.clone(), coordinator.clone());
            trace.step(match endpoint {
                Ok(_) => "Invoke endpoint ready; startup finished",
                Err(_) => "Invoke endpoint failed; startup finished",
            });
            // Start idle accounts' reset timers when the user turned it on.
            {
                let state = app.state::<accounts::AppState>().inner().clone();
                let woke = app.handle().clone();
                auto_wake::start(
                    state,
                    invoke.clone(),
                    Box::new(move |accounts| {
                        activity.record(activity::Activity::Woke {
                            accounts: accounts.to_vec(),
                        });
                        let _ = woke.emit("invoke-auto-woke", accounts);
                    }),
                );
            }
            // Learn which accounts can use which models, for Invoke routing.
            {
                let state = app.state::<accounts::AppState>().inner().clone();
                let invoke = invoke.clone();
                std::thread::spawn(move || {
                    let access = model_access::read(&state, &commands::codex_client_version());
                    invoke.remember_model_access(access);
                });
            }
            app.manage(coordinator);
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
            commands::get_app_version,
            commands::check_app_update,
            commands::install_app_update,
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
            commands::set_invoke_preferences,
            commands::set_account_invoke_allowed,
            commands::get_invoke_failover,
            commands::cancel_invoke_failover,
            commands::set_invoke_weekly_reserve,
            commands::get_invoke_tasks,
            commands::stop_invoke_task,
            commands::get_paused_threads,
            commands::get_activity,
            commands::get_invoke_pause,
            commands::resume_invoke
        ])
        .run(tauri::generate_context!())
        .expect("error while running GSwitch");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_builds_adopt_the_installed_builds_older_appdata_folder() {
        let roaming = PathBuf::from("roaming");
        assert_eq!(
            legacy_data_dir(roaming.join("com.light505.gswitchtool.dev")),
            roaming.join("com.light505.gswitchtool")
        );
        assert_eq!(
            legacy_data_dir(roaming.join("com.light505.gswitchtool")),
            roaming.join("com.light505.gswitchtool")
        );
    }
}
