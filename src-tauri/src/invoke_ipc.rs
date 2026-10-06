//! Local endpoint through which the Claude Code integration reads Invoke Mode
//! policy, validates a delegation request, and coordinates its Codex workers
//! with account failover. It listens only on a per-launch named pipe (Windows)
//! or a private Unix socket, requires a per-launch token stored in GSwitch's
//! private configuration directory, and exposes no method that changes policy,
//! accounts, or credentials.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use uuid::Uuid;

use crate::{
    failover::{Coordinator, FailoverCode, LeaseRequest},
    invoke::InvokeState,
    storage,
};

pub const ENDPOINT_FILE: &str = "invoke-endpoint.json";
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

pub struct Endpoint {
    token: String,
    invoke: InvokeState,
    coordinator: Arc<Coordinator>,
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    #[serde(default)]
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Publishes a fresh endpoint and token, then serves requests for the life of
/// the application. A stale endpoint file from an earlier launch only leads
/// a client to a connection failure, which it reports as GSwitch unavailable.
pub fn start(
    config_dir: &Path,
    invoke: InvokeState,
    coordinator: Arc<Coordinator>,
) -> Result<(), String> {
    let token = random_token()?;
    let path = endpoint_path(config_dir);
    // Tauri calls this from its setup hook on the main thread; the listener
    // must be created inside the async runtime that will serve it.
    let listener = tauri::async_runtime::block_on(async { Listener::bind(&path) })?;
    storage::write_json_atomic(
        &config_dir.join(ENDPOINT_FILE),
        &json!({
            "endpoint": path.to_string_lossy(),
            "token": token,
            "pid": std::process::id(),
        }),
        "Invoke Mode endpoint",
    )?;
    let endpoint = Arc::new(Endpoint {
        token,
        invoke,
        coordinator,
    });
    tauri::async_runtime::spawn(listener.serve(endpoint));
    Ok(())
}

/// Serves one connection. A worker keeps its connection open while it runs,
/// so a closed connection means the worker is gone.
async fn handle_connection<S>(stream: S, endpoint: Arc<Endpoint>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let connection = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    loop {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take(MAX_REQUEST_BYTES)
            .read_until(b'\n', &mut line)
            .await;
        if !matches!(read, Ok(length) if length > 0 && line.ends_with(b"\n")) {
            break;
        }
        let response = handle_line(&String::from_utf8_lossy(&line), &endpoint, connection).await;
        if writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .is_err()
        {
            break;
        }
    }
    endpoint.coordinator.drop_connection(connection);
}

/// Answers one JSON-lines request. Errors carry only a stable code.
pub(crate) async fn handle_line(line: &str, endpoint: &Endpoint, connection: u64) -> String {
    let response = match serde_json::from_str::<Request>(line.trim()) {
        Err(_) => error_response(Value::Null, "BAD_REQUEST"),
        Ok(request) if !token_matches(&request.token, &endpoint.token) => {
            error_response(request.id, "UNAUTHORIZED")
        }
        Ok(request) => match dispatch(&request.method, &request.params, endpoint, connection).await
        {
            Ok(result) => json!({ "id": request.id, "result": result }),
            Err(code) => error_response(request.id, &code),
        },
    };
    response.to_string()
}

async fn dispatch(
    method: &str,
    params: &Value,
    endpoint: &Endpoint,
    connection: u64,
) -> Result<Value, String> {
    let text = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "BAD_REQUEST".to_string())
    };
    let coordinator = &endpoint.coordinator;
    match method {
        "status" => {
            let settings = endpoint
                .invoke
                .settings()
                .map_err(|_| "UNAVAILABLE".to_string())?;
            // Manual Mode offers Claude nothing to choose from.
            let profiles = if settings.invoke_mode {
                settings.allowed_invocation_profiles
            } else {
                Vec::new()
            };
            let (running, failover) = coordinator.status();
            Ok(json!({
                "invoke_mode": settings.invoke_mode,
                "allowed_invocation_profiles": profiles,
                "workers_running": running,
                "failover_in_progress": failover,
                "waiting_for_codex_to_close": coordinator.waiting_for_codex().is_some(),
                "paused": coordinator.pause(),
                "workers": coordinator.workers(),
            }))
        }
        "validate" => {
            validate(endpoint, &text("model")?, &text("reasoning_effort")?)?;
            Ok(json!({ "allowed": true }))
        }
        "lease_open" => {
            let model = text("model")?;
            let reasoning_effort = text("reasoning_effort")?;
            validate(endpoint, &model, &reasoning_effort)?;
            let lease_id = coordinator.open_lease(
                connection,
                LeaseRequest {
                    model,
                    reasoning_effort,
                    write: params
                        .get("write")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    cwd: params
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                },
            );
            Ok(json!({ "lease_id": lease_id }))
        }
        "run_begin" => {
            coordinator
                .begin_run(&text("lease_id")?)
                .await
                .map_err(|failure| match failure {
                    FailoverCode::InvokePaused => paused(coordinator, failure),
                    _ => code(failure),
                })?;
            Ok(json!({}))
        }
        "run_app_server" => {
            let pid = params
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .ok_or_else(|| "BAD_REQUEST".to_string())?;
            coordinator
                .record_app_server(&text("lease_id")?, pid)
                .map_err(code)?;
            Ok(json!({}))
        }
        "run_thread" => {
            coordinator
                .record_thread(&text("lease_id")?, text("thread_id")?)
                .map_err(code)?;
            Ok(json!({}))
        }
        "run_end" => {
            let outcome = coordinator.end_run(&text("lease_id")?).map_err(code)?;
            Ok(json!({ "outcome": outcome }))
        }
        "limit_reached" => {
            let ack = coordinator.report_limit(&text("lease_id")?).map_err(code)?;
            Ok(json!({ "failover": ack }))
        }
        "await_failover" => {
            if let Err(failure) = coordinator.await_failover(&text("lease_id")?).await {
                if failure == FailoverCode::NoEligibleAccount {
                    return Err(paused(coordinator, failure));
                }
                // Keep the switch transaction's own reason for diagnosis.
                return Err(match coordinator.last_failure_detail() {
                    Some(detail) => format!("{}:{detail}", code(failure)),
                    None => code(failure),
                });
            }
            Ok(json!({}))
        }
        _ => Err("UNKNOWN_METHOD".to_string()),
    }
}

fn validate(endpoint: &Endpoint, model: &str, reasoning_effort: &str) -> Result<(), String> {
    endpoint
        .invoke
        .validate_request(model, reasoning_effort)
        .map_err(code)?;
    if endpoint.coordinator.pause().is_some() {
        return Err(paused(&endpoint.coordinator, FailoverCode::InvokePaused));
    }
    Ok(())
}

/// A code about the pause carries its reset time, in Unix seconds, when known.
fn paused(coordinator: &Coordinator, failure: FailoverCode) -> String {
    match coordinator.pause().and_then(|pause| pause.resumes_at) {
        Some(at) => format!("{}:{at}", code(failure)),
        None => code(failure),
    }
}

/// Serializes an error enum to its stable SCREAMING_SNAKE_CASE name.
fn code<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "UNAVAILABLE".to_string())
}

/// A code may carry the switch transaction's reason as `CODE:detail`.
fn error_response(id: Value, code: &str) -> Value {
    match code.split_once(':') {
        Some((code, detail)) => json!({ "id": id, "error": { "code": code, "detail": detail } }),
        None => json!({ "id": id, "error": { "code": code } }),
    }
}

fn token_matches(presented: &str, expected: &str) -> bool {
    presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Unable to create an Invoke Mode token".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(windows)]
fn endpoint_path(_config_dir: &Path) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\gswitch-invoke-{}", Uuid::new_v4()))
}

#[cfg(unix)]
fn endpoint_path(config_dir: &Path) -> PathBuf {
    // A short per-launch name keeps the socket path under the platform limit.
    config_dir.join(format!(
        "invoke-{}.sock",
        &Uuid::new_v4().simple().to_string()[..8]
    ))
}

#[cfg(windows)]
struct Listener {
    name: PathBuf,
    server: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Listener {
    fn bind(name: &Path) -> Result<Self, String> {
        let server = Self::instance(name, true)?;
        Ok(Self {
            name: name.to_path_buf(),
            server,
        })
    }

    fn instance(
        name: &Path,
        first: bool,
    ) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, String> {
        tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create(name)
            .map_err(|_| "Unable to open the Invoke Mode endpoint".to_string())
    }

    async fn serve(self, endpoint: Arc<Endpoint>) {
        let Self { name, mut server } = self;
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let Ok(next) = Self::instance(&name, false) else {
                return;
            };
            let connected = std::mem::replace(&mut server, next);
            tauri::async_runtime::spawn(handle_connection(connected, Arc::clone(&endpoint)));
        }
    }
}

#[cfg(unix)]
struct Listener {
    listener: tokio::net::UnixListener,
}

#[cfg(unix)]
impl Listener {
    fn bind(path: &Path) -> Result<Self, String> {
        use std::os::unix::fs::PermissionsExt;

        let _ = std::fs::remove_file(path);
        let std_listener = std::os::unix::net::UnixListener::bind(path)
            .map_err(|_| "Unable to open the Invoke Mode endpoint".to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Unable to protect the Invoke Mode endpoint".to_string())?;
        std_listener
            .set_nonblocking(true)
            .map_err(|_| "Unable to open the Invoke Mode endpoint".to_string())?;
        let listener = tokio::net::UnixListener::from_std(std_listener)
            .map_err(|_| "Unable to open the Invoke Mode endpoint".to_string())?;
        Ok(Self { listener })
    }

    async fn serve(self, endpoint: Arc<Endpoint>) {
        loop {
            let Ok((stream, _)) = self.listener.accept().await else {
                return;
            };
            tauri::async_runtime::spawn(handle_connection(stream, Arc::clone(&endpoint)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        failover::{FailoverOps, Timings},
        types::{AccountView, CatalogModel, InvocationProfile, QuotaSnapshot},
    };
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const TOKEN: &str = "test-token";

    /// One active account and no replacement: enough to route every method.
    struct FixedOps(InvokeState);

    impl FailoverOps for FixedOps {
        fn invoke_mode(&self) -> bool {
            self.0.settings().map(|s| s.invoke_mode).unwrap_or(false)
        }
        fn active_account(&self) -> Option<String> {
            Some("active".into())
        }
        fn accounts(&self) -> Vec<AccountView> {
            Vec::new()
        }
        fn read_quota(&self, _account_id: &str) -> Option<QuotaSnapshot> {
            None
        }
        fn switch_to(&self, _account_id: &str) -> Result<(), crate::failover::SwitchRefusal> {
            Err(FailoverCode::AccountSwitchFailed.into())
        }
        fn terminate(&self, _pid: u32) {}
        fn alive(&self, _pid: u32) -> bool {
            false
        }
        fn other_codex_running(&self) -> bool {
            false
        }
        fn waiting_for_codex(&self, _accounts: Option<&crate::failover::SwitchAccounts>) {}
        fn switched(&self, _from: &str, _to: &str) {}
        fn paused(&self, _pause: Option<&crate::failover::InvokePause>) {}
    }

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gswitch-ipc-{name}-{suffix}"));
        std::fs::create_dir_all(&path).expect("dir");
        path
    }

    fn endpoint(dir: &Path, enabled: bool) -> Endpoint {
        let invoke = InvokeState::load(dir.join("invoke.json"));
        let catalog = vec![CatalogModel {
            model: "model-a".into(),
            display_name: "Model A".into(),
            supported_reasoning_efforts: vec!["medium".into(), "high".into()],
            default_reasoning_effort: None,
            is_default: true,
        }];
        invoke
            .set_profiles(
                &[InvocationProfile {
                    model: "model-a".into(),
                    reasoning_efforts: vec!["high".into()],
                }],
                &catalog,
            )
            .expect("profiles");
        invoke.set_invoke_mode(enabled).expect("mode");
        let timings = Timings {
            start_grace: Duration::from_millis(50),
            shutdown: Duration::from_millis(50),
            wait: Duration::from_secs(5),
            user_close: Duration::from_secs(1),
            poll: Duration::from_millis(5),
        };
        Endpoint {
            token: TOKEN.into(),
            coordinator: Coordinator::new(Arc::new(FixedOps(invoke.clone())), timings),
            invoke,
        }
    }

    fn request(method: &str, params: Value) -> String {
        json!({ "id": 7, "token": TOKEN, "method": method, "params": params }).to_string()
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    fn call(line: &str, endpoint: &Endpoint) -> Value {
        serde_json::from_str(&block_on(handle_line(line, endpoint, 1))).expect("json response")
    }

    #[test]
    fn requests_without_the_launch_token_are_refused() {
        let dir = temp_dir("token");
        let endpoint = endpoint(&dir, true);
        let response = call(
            &json!({ "id": 1, "token": "wrong", "method": "status" }).to_string(),
            &endpoint,
        );
        assert_eq!(response["error"]["code"], "UNAUTHORIZED");
        assert!(response.get("result").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_and_unknown_requests_get_stable_codes() {
        let dir = temp_dir("malformed");
        let endpoint = endpoint(&dir, true);
        assert_eq!(call("not json", &endpoint)["error"]["code"], "BAD_REQUEST");
        assert_eq!(
            call(
                &request("set_invoke_mode", json!({"enabled": true})),
                &endpoint
            )["error"]["code"],
            "UNKNOWN_METHOD"
        );
        assert_eq!(
            call(&request("validate", json!({"model": "model-a"})), &endpoint)["error"]["code"],
            "BAD_REQUEST"
        );
        assert_eq!(
            call(
                &request("run_end", json!({"lease_id": "missing"})),
                &endpoint
            )["error"]["code"],
            "UNKNOWN_LEASE"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn status_reports_policy_only_while_invoke_mode_is_on() {
        let dir = temp_dir("status");
        let endpoint = endpoint(&dir, true);
        let response = call(&request("status", Value::Null), &endpoint);
        assert_eq!(response["id"], 7);
        assert_eq!(
            response["result"],
            json!({
                "invoke_mode": true,
                "allowed_invocation_profiles": [{"model": "model-a", "reasoning_efforts": ["high"]}],
                "workers_running": 0,
                "failover_in_progress": false,
                "waiting_for_codex_to_close": false,
                "paused": null,
                "workers": [],
            })
        );

        endpoint.invoke.set_invoke_mode(false).expect("manual");
        let manual = call(&request("status", Value::Null), &endpoint);
        assert_eq!(manual["result"]["invoke_mode"], false);
        assert_eq!(manual["result"]["allowed_invocation_profiles"], json!([]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_and_lease_open_return_the_policy_rejection_code() {
        let dir = temp_dir("validate");
        let endpoint = endpoint(&dir, true);
        for method in ["validate", "lease_open"] {
            let ask = |model: &str, effort: &str| {
                call(
                    &request(method, json!({"model": model, "reasoning_effort": effort})),
                    &endpoint,
                )
            };
            assert!(ask("model-a", "high").get("result").is_some());
            assert_eq!(ask("model-b", "high")["error"]["code"], "MODEL_NOT_ALLOWED");
            assert_eq!(
                ask("model-a", "medium")["error"]["code"],
                "REASONING_NOT_ALLOWED"
            );
        }
        endpoint.invoke.set_invoke_mode(false).expect("manual");
        assert_eq!(
            call(
                &request(
                    "lease_open",
                    json!({"model": "model-a", "reasoning_effort": "high"})
                ),
                &endpoint
            )["error"]["code"],
            "INVOKE_MODE_DISABLED"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_worker_run_is_registered_and_reported_in_status() {
        let dir = temp_dir("lease");
        let endpoint = endpoint(&dir, true);
        let opened = call(
            &request(
                "lease_open",
                json!({"model": "model-a", "reasoning_effort": "high", "write": true, "cwd": "/repo"}),
            ),
            &endpoint,
        );
        let lease = opened["result"]["lease_id"]
            .as_str()
            .expect("lease")
            .to_string();
        let ok = |method: &str, extra: Value| {
            let mut params = json!({ "lease_id": lease });
            params
                .as_object_mut()
                .expect("object")
                .extend(extra.as_object().cloned().unwrap_or_default());
            call(&request(method, params), &endpoint)
        };
        assert_eq!(ok("run_begin", json!({}))["result"], json!({}));
        assert_eq!(
            ok("run_app_server", json!({"pid": 4242}))["result"],
            json!({})
        );
        assert_eq!(
            ok("run_thread", json!({"thread_id": "thr_1"}))["result"],
            json!({})
        );

        let status = call(&request("status", Value::Null), &endpoint)["result"].clone();
        assert_eq!(status["workers_running"], 1);
        assert_eq!(
            status["workers"],
            json!([{"model": "model-a", "reasoning_effort": "high", "write": true, "cwd": "/repo", "thread_id": "thr_1", "running": true}])
        );
        assert_eq!(ok("run_end", json!({}))["result"]["outcome"], "unchanged");

        endpoint.invoke.set_invoke_mode(false).expect("manual");
        assert_eq!(
            ok("limit_reached", json!({}))["error"]["code"],
            "INVOKE_MODE_DISABLED"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn running_out_with_no_account_left_pauses_every_new_request() {
        let dir = temp_dir("paused");
        let endpoint = endpoint(&dir, true);
        let lease = call(
            &request(
                "lease_open",
                json!({"model": "model-a", "reasoning_effort": "high", "write": false, "cwd": "/repo"}),
            ),
            &endpoint,
        )["result"]["lease_id"]
            .as_str()
            .expect("lease")
            .to_string();
        let ok = |method: &str| call(&request(method, json!({ "lease_id": lease })), &endpoint);
        assert_eq!(ok("run_begin")["result"], json!({}));
        assert_eq!(ok("run_end")["result"]["outcome"], "unchanged");
        assert_eq!(ok("limit_reached")["result"]["failover"], "started");
        // No saved account can take over, so no reset time is known.
        assert_eq!(
            ok("await_failover")["error"],
            json!({ "code": "NO_ELIGIBLE_ACCOUNT" })
        );

        let status = call(&request("status", Value::Null), &endpoint)["result"].clone();
        assert_eq!(status["paused"], json!({ "resumes_at": null }));
        assert_eq!(ok("run_begin")["error"]["code"], "INVOKE_PAUSED");
        assert_eq!(
            call(
                &request(
                    "validate",
                    json!({"model": "model-a", "reasoning_effort": "high"})
                ),
                &endpoint
            )["error"]["code"],
            "INVOKE_PAUSED"
        );

        endpoint.coordinator.resume();
        assert_eq!(
            call(
                &request(
                    "validate",
                    json!({"model": "model-a", "reasoning_effort": "high"})
                ),
                &endpoint
            )["result"],
            json!({ "allowed": true })
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Account "a" is active and runs out; "b" is allowed with quota. Process
    /// control is real so the worker's App Server is really stopped.
    struct EndToEndOps {
        invoke: InvokeState,
        active: std::sync::Mutex<String>,
        switches: std::sync::Mutex<Vec<String>>,
    }

    impl FailoverOps for EndToEndOps {
        fn invoke_mode(&self) -> bool {
            self.invoke
                .settings()
                .map(|s| s.invoke_mode)
                .unwrap_or(false)
        }
        fn active_account(&self) -> Option<String> {
            Some(self.active.lock().expect("active").clone())
        }
        fn accounts(&self) -> Vec<AccountView> {
            ["a", "b"]
                .iter()
                .map(|id| AccountView {
                    id: (*id).into(),
                    label: (*id).into(),
                    kind: crate::types::AccountKind::ChatGpt,
                    email: None,
                    plan_type: None,
                    workspace_name: None,
                    active: false,
                    needs_apply: false,
                    sign_in_required: false,
                    revision: 1,
                    invoke_allowed: true,
                })
                .collect()
        }
        fn read_quota(&self, account_id: &str) -> Option<QuotaSnapshot> {
            (account_id == "b").then(|| QuotaSnapshot {
                fetched_at_unix_ms: 1,
                account_id: None,
                ordinary_usage_allowed: Some(true),
                buckets: Vec::new(),
                reset_credits: None,
            })
        }
        fn switch_to(&self, account_id: &str) -> Result<(), crate::failover::SwitchRefusal> {
            self.switches
                .lock()
                .expect("switches")
                .push(account_id.into());
            *self.active.lock().expect("active") = account_id.into();
            Ok(())
        }
        fn terminate(&self, pid: u32) {
            crate::runtime::terminate_process_tree(pid);
        }
        fn alive(&self, pid: u32) -> bool {
            crate::runtime::process_alive(pid)
        }
        fn other_codex_running(&self) -> bool {
            false
        }
        fn waiting_for_codex(&self, _accounts: Option<&crate::failover::SwitchAccounts>) {}
        fn switched(&self, _from: &str, _to: &str) {}
        fn paused(&self, _pause: Option<&crate::failover::InvokePause>) {}
    }

    #[test]
    #[ignore = "runs the Claude Code plugin's invoke command with Node and a fake Codex"]
    fn the_plugin_worker_resumes_its_thread_after_a_real_coordinator_failover() {
        let dir = temp_dir("end-to-end");
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../integrations/codex-plugin-cc");
        let repo = dir.join("repo");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&repo).expect("repo");
        std::fs::create_dir_all(&bin).expect("bin");
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git")
                .status
                .success());
        };
        git(&["init", "-q", "-b", "main"]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let fixture = plugin.join("tests/fake-codex-fixture.mjs");
        let install = format!(
            "import({:?}).then((m) => m.installFakeCodex({:?}, 'usage-limit-once'))",
            url_for(&fixture),
            bin.to_string_lossy()
        );
        assert!(std::process::Command::new("node")
            .args(["--input-type=module", "-e", &install])
            .status()
            .expect("node")
            .success());

        let base = endpoint(&dir, true);
        let ops = Arc::new(EndToEndOps {
            invoke: base.invoke.clone(),
            active: std::sync::Mutex::new("a".into()),
            switches: std::sync::Mutex::new(Vec::new()),
        });
        let endpoint = Arc::new(Endpoint {
            token: TOKEN.into(),
            invoke: base.invoke.clone(),
            coordinator: Coordinator::new(ops.clone(), Timings::default()),
        });
        let path = endpoint_path(&dir);
        storage::write_json_atomic(
            &dir.join(ENDPOINT_FILE),
            &json!({ "endpoint": path.to_string_lossy(), "token": TOKEN, "pid": 1 }),
            "endpoint",
        )
        .expect("endpoint file");

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let output = runtime.block_on(async {
            let listener = Listener::bind(&path).expect("bind");
            tokio::spawn(listener.serve(Arc::clone(&endpoint)));
            let separator = if cfg!(windows) { ";" } else { ":" };
            let search_path = format!(
                "{}{separator}{}",
                bin.to_string_lossy(),
                std::env::var("PATH").unwrap_or_default()
            );
            let script = plugin.join("plugins/codex/scripts/codex-companion.mjs");
            let repo = repo.clone();
            let dir = dir.clone();
            tokio::task::spawn_blocking(move || {
                std::process::Command::new("node")
                    .arg(script)
                    .args([
                        "invoke", "--json", "--model", "model-a", "--effort", "high", "--write",
                        "build it",
                    ])
                    .current_dir(&repo)
                    .env("PATH", search_path)
                    .env("GSWITCH_CONFIG_DIR", &dir)
                    .env("CLAUDE_PLUGIN_DATA", dir.join("plugin-data"))
                    .output()
                    .expect("companion")
            })
            .await
            .expect("join")
        });

        let stdout = String::from_utf8_lossy(&output.stdout);
        let result: Value = serde_json::from_str(&stdout).unwrap_or_else(|_| {
            panic!(
                "stdout: {stdout}\nstderr: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        });
        assert_eq!(result["status"], "completed", "{result}");
        assert_eq!(result["failovers"], 1);
        assert_eq!(
            *ops.switches.lock().expect("switches"),
            vec!["b".to_string()]
        );
        let state: Value = serde_json::from_str(
            &std::fs::read_to_string(bin.join("fake-codex-state.json")).expect("fake state"),
        )
        .expect("state json");
        let turns = state["turns"].as_array().expect("turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["threadId"], turns[1]["threadId"]);
        assert_eq!(turns[1]["model"], "model-a");
        assert_eq!(turns[1]["effort"], "high");
        assert!(turns[1]["prompt"]
            .as_str()
            .expect("prompt")
            .starts_with("Authentication changed because the previous Codex account"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn url_for(path: &Path) -> String {
        let absolute = std::fs::canonicalize(path).expect("canonical");
        let text = absolute.to_string_lossy().replace('\\', "/");
        let text = text.trim_start_matches("//?/");
        if text.starts_with('/') {
            format!("file://{text}")
        } else {
            format!("file:///{text}")
        }
    }

    #[test]
    fn starts_from_the_setup_thread_and_publishes_a_working_endpoint() {
        // Called without a Tokio runtime, exactly as Tauri's setup hook does.
        let dir = temp_dir("start");
        let base = endpoint(&dir, true);
        start(&dir, base.invoke.clone(), Arc::clone(&base.coordinator)).expect("start");

        let published: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(ENDPOINT_FILE)).expect("endpoint file"),
        )
        .expect("endpoint json");
        let path = PathBuf::from(published["endpoint"].as_str().expect("endpoint"));
        let token = published["token"].as_str().expect("token").to_string();
        let line = block_on(async move {
            #[cfg(windows)]
            let client = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(&path)
                .expect("open pipe");
            #[cfg(unix)]
            let client = tokio::net::UnixStream::connect(&path)
                .await
                .expect("connect socket");
            let (reader, mut writer) = tokio::io::split(client);
            let request = json!({ "id": 1, "token": token, "method": "status" });
            writer
                .write_all(format!("{request}\n").as_bytes())
                .await
                .expect("write");
            BufReader::new(reader)
                .lines()
                .next_line()
                .await
                .expect("read")
                .expect("line")
        });
        let response: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(response["result"]["invoke_mode"], true);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn serves_json_lines_and_forgets_a_worker_when_its_connection_closes() {
        let dir = temp_dir("endpoint");
        let endpoint = Arc::new(endpoint(&dir, true));
        let path = endpoint_path(&dir);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let server_endpoint = Arc::clone(&endpoint);
        let line = runtime.block_on(async {
            let listener = Listener::bind(&path).expect("bind");
            let accept = tokio::spawn(async move {
                #[cfg(windows)]
                {
                    let server = listener.server;
                    server.connect().await.expect("connect");
                    handle_connection(server, server_endpoint).await;
                }
                #[cfg(unix)]
                {
                    let (stream, _) = listener.listener.accept().await.expect("accept");
                    handle_connection(stream, server_endpoint).await;
                }
            });

            #[cfg(windows)]
            let client = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(&path)
                .expect("open pipe");
            #[cfg(unix)]
            let client = tokio::net::UnixStream::connect(&path)
                .await
                .expect("connect socket");

            let (reader, mut writer) = tokio::io::split(client);
            let mut lines = BufReader::new(reader).lines();
            writer
                .write_all(
                    format!(
                        "{}\n",
                        request(
                            "lease_open",
                            json!({"model": "model-a", "reasoning_effort": "high"})
                        )
                    )
                    .as_bytes(),
                )
                .await
                .expect("write");
            let line = lines.next_line().await.expect("read").expect("line");
            assert_eq!(endpoint.coordinator.workers().len(), 1);
            drop(writer);
            drop(lines);
            accept.await.expect("server task");
            line
        });
        let response: Value = serde_json::from_str(&line).expect("json");
        assert!(response["result"]["lease_id"].is_string());
        assert!(endpoint.coordinator.workers().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
