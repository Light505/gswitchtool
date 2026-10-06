//! Local endpoint through which the Claude Code integration reads Invoke Mode
//! policy and validates a delegation request. It listens only on a per-launch
//! named pipe (Windows) or a private Unix socket, requires a per-launch token
//! stored in GSwitch's private configuration directory, and exposes no method
//! that changes policy, accounts, or credentials.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use uuid::Uuid;

use crate::{invoke::InvokeState, storage};

pub const ENDPOINT_FILE: &str = "invoke-endpoint.json";
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

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
pub fn start(config_dir: &Path, invoke: InvokeState) -> Result<(), String> {
    let token = random_token()?;
    let endpoint = endpoint_path(config_dir);
    let listener = Listener::bind(&endpoint)?;
    storage::write_json_atomic(
        &config_dir.join(ENDPOINT_FILE),
        &json!({
            "endpoint": endpoint.to_string_lossy(),
            "token": token,
            "pid": std::process::id(),
        }),
        "Invoke Mode endpoint",
    )?;
    tauri::async_runtime::spawn(listener.serve(token, invoke));
    Ok(())
}

async fn handle_connection<S>(stream: S, token: String, invoke: InvokeState)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    loop {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take(MAX_REQUEST_BYTES)
            .read_until(b'\n', &mut line)
            .await;
        match read {
            Ok(0) | Err(_) => return,
            Ok(_) if !line.ends_with(b"\n") => return,
            Ok(_) => {}
        }
        let response = handle_line(&String::from_utf8_lossy(&line), &token, &invoke);
        if writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .is_err()
        {
            return;
        }
    }
}

/// Answers one JSON-lines request. Errors carry only a stable code.
pub(crate) fn handle_line(line: &str, token: &str, invoke: &InvokeState) -> String {
    let response = match serde_json::from_str::<Request>(line.trim()) {
        Err(_) => error_response(Value::Null, "BAD_REQUEST"),
        Ok(request) if !token_matches(&request.token, token) => {
            error_response(request.id, "UNAUTHORIZED")
        }
        Ok(request) => match dispatch(&request.method, &request.params, invoke) {
            Ok(result) => json!({ "id": request.id, "result": result }),
            Err(code) => error_response(request.id, &code),
        },
    };
    response.to_string()
}

fn dispatch(method: &str, params: &Value, invoke: &InvokeState) -> Result<Value, String> {
    match method {
        "status" => {
            let settings = invoke.settings().map_err(|_| "UNAVAILABLE".to_string())?;
            // Manual Mode offers Claude nothing to choose from.
            let profiles = if settings.invoke_mode {
                settings.allowed_invocation_profiles
            } else {
                Vec::new()
            };
            Ok(json!({
                "invoke_mode": settings.invoke_mode,
                "allowed_invocation_profiles": profiles,
                "workers_running": 0,
                "failover_in_progress": false,
            }))
        }
        "validate" => {
            let field = |name: &str| {
                params
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| "BAD_REQUEST".to_string())
            };
            invoke
                .validate_request(&field("model")?, &field("reasoning_effort")?)
                .map(|()| json!({ "allowed": true }))
                .map_err(|rejection| {
                    serde_json::to_value(rejection)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_string))
                        .unwrap_or_else(|| "UNAVAILABLE".to_string())
                })
        }
        _ => Err("UNKNOWN_METHOD".to_string()),
    }
}

fn error_response(id: Value, code: &str) -> Value {
    json!({ "id": id, "error": { "code": code } })
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

    async fn serve(self, token: String, invoke: InvokeState) {
        let Self { name, mut server } = self;
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let Ok(next) = Self::instance(&name, false) else {
                return;
            };
            let connected = std::mem::replace(&mut server, next);
            tauri::async_runtime::spawn(handle_connection(
                connected,
                token.clone(),
                invoke.clone(),
            ));
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

    async fn serve(self, token: String, invoke: InvokeState) {
        loop {
            let Ok((stream, _)) = self.listener.accept().await else {
                return;
            };
            tauri::async_runtime::spawn(handle_connection(stream, token.clone(), invoke.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CatalogModel, InvocationProfile};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TOKEN: &str = "test-token";

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("gswitch-ipc-{name}-{suffix}"));
        std::fs::create_dir_all(&path).expect("dir");
        path
    }

    fn invoke_state(dir: &Path, enabled: bool) -> InvokeState {
        let state = InvokeState::load(dir.join("invoke.json"));
        let catalog = vec![CatalogModel {
            model: "model-a".into(),
            display_name: "Model A".into(),
            supported_reasoning_efforts: vec!["medium".into(), "high".into()],
            default_reasoning_effort: None,
            is_default: true,
        }];
        state
            .set_profiles(
                &[InvocationProfile {
                    model: "model-a".into(),
                    reasoning_efforts: vec!["high".into()],
                }],
                &catalog,
            )
            .expect("profiles");
        state.set_invoke_mode(enabled).expect("mode");
        state
    }

    fn request(method: &str, params: Value) -> String {
        json!({ "id": 7, "token": TOKEN, "method": method, "params": params }).to_string()
    }

    fn call(line: &str, invoke: &InvokeState) -> Value {
        serde_json::from_str(&handle_line(line, TOKEN, invoke)).expect("json response")
    }

    #[test]
    fn requests_without_the_launch_token_are_refused() {
        let dir = temp_dir("token");
        let invoke = invoke_state(&dir, true);
        let response = call(
            &json!({ "id": 1, "token": "wrong", "method": "status" }).to_string(),
            &invoke,
        );
        assert_eq!(response["error"]["code"], "UNAUTHORIZED");
        assert!(response.get("result").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_and_unknown_requests_get_stable_codes() {
        let dir = temp_dir("malformed");
        let invoke = invoke_state(&dir, true);
        assert_eq!(call("not json", &invoke)["error"]["code"], "BAD_REQUEST");
        assert_eq!(
            call(
                &request("set_invoke_mode", json!({"enabled": true})),
                &invoke
            )["error"]["code"],
            "UNKNOWN_METHOD"
        );
        assert_eq!(
            call(&request("validate", json!({"model": "model-a"})), &invoke)["error"]["code"],
            "BAD_REQUEST"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn status_reports_policy_only_while_invoke_mode_is_on() {
        let dir = temp_dir("status");
        let invoke = invoke_state(&dir, true);
        let response = call(&request("status", Value::Null), &invoke);
        assert_eq!(response["id"], 7);
        assert_eq!(
            response["result"],
            json!({
                "invoke_mode": true,
                "allowed_invocation_profiles": [{"model": "model-a", "reasoning_efforts": ["high"]}],
                "workers_running": 0,
                "failover_in_progress": false,
            })
        );

        invoke.set_invoke_mode(false).expect("manual");
        let manual = call(&request("status", Value::Null), &invoke);
        assert_eq!(manual["result"]["invoke_mode"], false);
        assert_eq!(manual["result"]["allowed_invocation_profiles"], json!([]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validate_returns_the_policy_rejection_code() {
        let dir = temp_dir("validate");
        let invoke = invoke_state(&dir, true);
        let validate = |model: &str, effort: &str| {
            call(
                &request(
                    "validate",
                    json!({"model": model, "reasoning_effort": effort}),
                ),
                &invoke,
            )
        };
        assert_eq!(validate("model-a", "high")["result"]["allowed"], true);
        assert_eq!(
            validate("model-b", "high")["error"]["code"],
            "MODEL_NOT_ALLOWED"
        );
        assert_eq!(
            validate("model-a", "medium")["error"]["code"],
            "REASONING_NOT_ALLOWED"
        );
        invoke.set_invoke_mode(false).expect("manual");
        assert_eq!(
            validate("model-a", "high")["error"]["code"],
            "INVOKE_MODE_DISABLED"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn serves_json_lines_over_the_local_endpoint() {
        let dir = temp_dir("endpoint");
        let invoke = invoke_state(&dir, true);
        let endpoint = endpoint_path(&dir);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let response = runtime.block_on(async {
            let listener = Listener::bind(&endpoint).expect("bind");
            let accept = tokio::spawn(async move {
                #[cfg(windows)]
                {
                    let server = listener.server;
                    server.connect().await.expect("connect");
                    handle_connection(server, TOKEN.to_string(), invoke).await;
                }
                #[cfg(unix)]
                {
                    let (stream, _) = listener.listener.accept().await.expect("accept");
                    handle_connection(stream, TOKEN.to_string(), invoke).await;
                }
            });

            #[cfg(windows)]
            let client = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(&endpoint)
                .expect("open pipe");
            #[cfg(unix)]
            let client = tokio::net::UnixStream::connect(&endpoint)
                .await
                .expect("connect socket");

            let (reader, mut writer) = tokio::io::split(client);
            writer
                .write_all(format!("{}\n", request("status", Value::Null)).as_bytes())
                .await
                .expect("write");
            let mut lines = BufReader::new(reader).lines();
            let line = lines.next_line().await.expect("read").expect("line");
            drop(writer);
            drop(lines);
            accept.await.expect("server task");
            line
        });
        let response: Value = serde_json::from_str(&response).expect("json");
        assert_eq!(response["result"]["invoke_mode"], true);
        let _ = std::fs::remove_dir_all(dir);
    }
}
