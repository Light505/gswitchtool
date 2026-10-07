//! In-app updates for the installed GSwitch Claude Tool (added by Light505 for
//! gswitchtool). Updates are GitHub releases of the private repository, read
//! with the user's own GitHub sign-in from Git Credential Manager. The
//! credential stays in this process and is sent only to GitHub's API for this
//! repository. The updater verifies each installer against the public key in
//! `tauri.main.conf.json` before running it. The dev build never updates.

use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::runtime;

const REPOSITORY: &str = "Light505/gswitchtool";
const API: &str = "https://api.github.com";
/// The release asset that describes the update for the Tauri updater.
const MANIFEST_ASSET: &str = "latest.json";
const USER_AGENT: &str = "gswitchtool-updater";
const CREDENTIAL_TIMEOUT: Duration = Duration::from_secs(15);

/// Why an update check or install did not go ahead. Never carries the
/// credential or GitHub's response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppUpdateFailure {
    /// The dev build never updates itself.
    UpdatesDisabled,
    /// Git has no saved GitHub sign-in, or Git is missing.
    GithubSignInMissing,
    /// GitHub refused the sign-in, or it cannot read the repository.
    GithubAccessDenied,
    Unavailable,
    /// The release points somewhere other than this repository's assets.
    UntrustedRelease,
    /// Claude's delegated Codex work is running; updating would stop it.
    InvokeBusy,
    NoUpdate,
    NoPreviousRelease,
    InstallFailed,
}

/// What the window shows about an available update.
#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateView {
    pub version: String,
    pub notes: Option<String>,
}

/// Download progress, in the shape of the Tauri updater's own events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// The update found by the last check, kept for the user's decision.
#[derive(Default)]
pub struct AppUpdateState {
    pending: Mutex<Option<Update>>,
}

/// Only the installed identity updates; Dev must never replace the installed app.
fn updates_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    !crate::build_identity::is_dev_identifier(&app.config().identifier)
}

pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<AppUpdateView>, AppUpdateFailure> {
    if !updates_enabled(app) {
        return Err(AppUpdateFailure::UpdatesDisabled);
    }
    let (token, manifest) = tauri::async_runtime::spawn_blocking(|| {
        let token = github_token()?;
        let manifest = latest_manifest_url(&token)?;
        Ok::<_, AppUpdateFailure>((token, manifest))
    })
    .await
    .map_err(|_| AppUpdateFailure::Unavailable)??;
    let Some(manifest) = manifest else {
        *app.state::<AppUpdateState>()
            .pending
            .lock()
            .expect("update state") = None;
        return Ok(None);
    };
    check_manifest(app, token, manifest, None).await
}

/// Added by Light505: offer only the nearest older stable installed-app release.
pub async fn check_rollback<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<AppUpdateView>, AppUpdateFailure> {
    if !updates_enabled(app) {
        return Err(AppUpdateFailure::UpdatesDisabled);
    }
    let current = &app.package_info().version;
    let current = [current.major, current.minor, current.patch];
    let (token, version, manifest) = tauri::async_runtime::spawn_blocking(move || {
        let token = github_token()?;
        let releases = published_releases(&token)?;
        let (version, manifest) = previous_release(&releases, current)?;
        Ok::<_, AppUpdateFailure>((token, version, manifest))
    })
    .await
    .map_err(|_| AppUpdateFailure::Unavailable)??;
    check_manifest(app, token, manifest, Some(version)).await
}

async fn check_manifest<R: Runtime>(
    app: &AppHandle<R>,
    token: String,
    manifest: String,
    target_version: Option<String>,
) -> Result<Option<AppUpdateView>, AppUpdateFailure> {
    let endpoint = manifest
        .parse()
        .map_err(|_| AppUpdateFailure::UntrustedRelease)?;
    let builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.header("Authorization", format!("Bearer {token}")))
        // GitHub serves an asset's bytes, not its description, for this type;
        // the updater keeps it for the installer download too.
        .and_then(|builder| builder.header("Accept", "application/octet-stream"))
        .and_then(|builder| builder.header("User-Agent", USER_AGENT))
        .and_then(|builder| builder.header("X-GitHub-Api-Version", "2022-11-28"))
        .map_err(|_| AppUpdateFailure::Unavailable)?;
    let rollback = target_version.is_some();
    let builder = match target_version {
        Some(target) => {
            builder.version_comparator(move |_, release| rollback_target_matches(&target, &release))
        }
        None => builder,
    };
    let update = builder
        .build()
        .map_err(|_| AppUpdateFailure::Unavailable)?
        .check()
        .await
        .map_err(|_| AppUpdateFailure::Unavailable)?;
    let Some(update) = update else {
        *app.state::<AppUpdateState>()
            .pending
            .lock()
            .expect("update state") = None;
        return if rollback {
            Err(AppUpdateFailure::UntrustedRelease)
        } else {
            Ok(None)
        };
    };
    // The download carries the credential, so it may go only to this
    // repository's release assets.
    if !is_release_asset(update.download_url.as_str()) {
        return Err(AppUpdateFailure::UntrustedRelease);
    }
    let view = AppUpdateView {
        version: update.version.clone(),
        notes: update.body.clone(),
    };
    *app.state::<AppUpdateState>()
        .pending
        .lock()
        .expect("update state") = Some(update);
    Ok(Some(view))
}

/// Downloads, verifies, and runs the installer the user agreed to. On
/// Windows the installer replaces the app and this process exits.
pub async fn install<R: Runtime>(
    app: &AppHandle<R>,
    invoke_busy: bool,
    version: &str,
    events: Channel<DownloadEvent>,
) -> Result<(), AppUpdateFailure> {
    if invoke_busy {
        return Err(AppUpdateFailure::InvokeBusy);
    }
    let update = {
        let state = app.state::<AppUpdateState>();
        let mut pending = state.pending.lock().expect("update state");
        if !pending
            .as_ref()
            .is_some_and(|update| update.version == version)
        {
            return Err(AppUpdateFailure::NoUpdate);
        }
        pending.take().ok_or(AppUpdateFailure::NoUpdate)?
    };
    let mut started = false;
    let result = update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = events.send(DownloadEvent::Started { content_length });
                }
                let _ = events.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = events.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|_| AppUpdateFailure::InstallFailed);
    if result.is_err() {
        // Keep the confirmed signed target available for the existing Retry UI.
        let state = app.state::<AppUpdateState>();
        let mut pending = state.pending.lock().expect("update state");
        if pending.is_none() {
            *pending = Some(update);
        }
    }
    result
}

fn is_release_asset(url: &str) -> bool {
    url.strip_prefix(&format!("{API}/repos/{REPOSITORY}/releases/assets/"))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    url: String,
}

/// Stable vX.Y.Z tags only; numeric ordering without adding a dependency.
fn release_version(tag: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = tag.strip_prefix('v')?.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut version = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        version[index] = part.parse().ok()?;
    }
    Some(version)
}

fn rollback_target_matches(target: &str, release: &tauri_plugin_updater::RemoteRelease) -> bool {
    release.version.to_string() == target
}

fn previous_release(
    releases: &[Release],
    current: [u64; 3],
) -> Result<(String, String), AppUpdateFailure> {
    let release = releases
        .iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| release_version(&release.tag_name).map(|version| (version, release)))
        .filter(|(version, _)| *version < current)
        .max_by_key(|(version, _)| *version)
        .map(|(_, release)| release)
        .ok_or(AppUpdateFailure::NoPreviousRelease)?;
    Ok((release.tag_name[1..].to_string(), manifest_url(release)?))
}

fn published_releases(token: &str) -> Result<Vec<Release>, AppUpdateFailure> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| AppUpdateFailure::Unavailable)?
        .get(format!("{API}/repos/{REPOSITORY}/releases?per_page=50"))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| AppUpdateFailure::Unavailable)?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 | 404 => return Err(AppUpdateFailure::GithubAccessDenied),
        _ => return Err(AppUpdateFailure::Unavailable),
    }
    let mut body = Vec::new();
    response
        .take(4 * 1024 * 1024)
        .read_to_end(&mut body)
        .map_err(|_| AppUpdateFailure::Unavailable)?;
    serde_json::from_slice(&body).map_err(|_| AppUpdateFailure::Unavailable)
}

/// The API address of the latest published release's manifest, or `None`
/// when nothing has been released.
fn latest_manifest_url(token: &str) -> Result<Option<String>, AppUpdateFailure> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| AppUpdateFailure::Unavailable)?;
    let get = |path: &str| {
        client
            .get(format!("{API}/repos/{REPOSITORY}{path}"))
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .map_err(|_| AppUpdateFailure::Unavailable)
    };
    let response = get("/releases/latest")?;
    match response.status().as_u16() {
        200 => {}
        // GitHub also answers 404 to a sign-in that cannot see a private
        // repository; only a readable repository means "nothing released".
        404 => {
            return match get("")?.status().as_u16() {
                200 => Ok(None),
                401 | 403 | 404 => Err(AppUpdateFailure::GithubAccessDenied),
                _ => Err(AppUpdateFailure::Unavailable),
            }
        }
        401 | 403 => return Err(AppUpdateFailure::GithubAccessDenied),
        _ => return Err(AppUpdateFailure::Unavailable),
    }
    let mut body = Vec::new();
    response
        .take(4 * 1024 * 1024)
        .read_to_end(&mut body)
        .map_err(|_| AppUpdateFailure::Unavailable)?;
    let release: Release =
        serde_json::from_slice(&body).map_err(|_| AppUpdateFailure::Unavailable)?;
    manifest_url(&release).map(Some)
}

fn manifest_url(release: &Release) -> Result<String, AppUpdateFailure> {
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == MANIFEST_ASSET)
        .ok_or(AppUpdateFailure::Unavailable)?;
    if !is_release_asset(&asset.url) {
        return Err(AppUpdateFailure::UntrustedRelease);
    }
    Ok(asset.url.clone())
}

/// Asks Git for the saved github.com sign-in without ever prompting: a
/// background check must not open a sign-in window.
fn github_token() -> Result<String, AppUpdateFailure> {
    let mut command = git_command();
    command
        .args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    runtime::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| AppUpdateFailure::GithubSignInMissing)?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"protocol=https\nhost=github.com\n\n");
    }
    let mut stdout = child.stdout.take().ok_or(AppUpdateFailure::Unavailable)?;
    let reader = thread::spawn(move || {
        let mut output = String::new();
        stdout.read_to_string(&mut output).ok().map(|_| output)
    });
    let deadline = Instant::now() + CREDENTIAL_TIMEOUT;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let output = reader.join().ok().flatten().unwrap_or_default();
    if !success {
        return Err(AppUpdateFailure::GithubSignInMissing);
    }
    credential_password(&output).ok_or(AppUpdateFailure::GithubSignInMissing)
}

fn credential_password(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .map(str::trim)
        .filter(|password| !password.is_empty())
        .map(str::to_string)
}

/// A desktop process may not have Git on PATH; use Git for Windows' usual
/// location when it does not.
fn git_command() -> Command {
    #[cfg(windows)]
    {
        let on_path = std::env::var_os("PATH").is_some_and(|path| {
            std::env::split_paths(&path).any(|dir| dir.join("git.exe").is_file())
        });
        if !on_path {
            for base in ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"] {
                if let Some(dir) = std::env::var_os(base) {
                    let candidates = [
                        std::path::Path::new(&dir)
                            .join("Git")
                            .join("cmd")
                            .join("git.exe"),
                        std::path::Path::new(&dir)
                            .join("Programs")
                            .join("Git")
                            .join("cmd")
                            .join("git.exe"),
                    ];
                    if let Some(git) = candidates.into_iter().find(|path| path.is_file()) {
                        return Command::new(git);
                    }
                }
            }
        }
    }
    Command::new("git")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> Release {
        serde_json::from_value(serde_json::json!({
            "tag_name": tag, "draft": false, "prerelease": false,
            "assets": [{ "name": "latest.json", "url": "https://api.github.com/repos/Light505/gswitchtool/releases/assets/2" }]
        })).expect("release")
    }

    #[test]
    fn rollback_selects_only_the_highest_older_stable_release() {
        let mut draft = release("v1.10.9");
        draft.draft = true;
        let mut prerelease = release("v1.10.8");
        prerelease.prerelease = true;
        let releases = [
            release("v1.9.0"),
            release("v1.10.0"),
            release("v1.11.0"),
            release("v2.0.0"),
            draft,
            prerelease,
            release("1.10.7"),
            release("v1.10.6-beta.1"),
            release("v1.10.5+build"),
            release("v1.010.4"),
            release("v1.10"),
            release("v1.10.3.0"),
        ];
        assert_eq!(
            previous_release(&releases, [1, 11, 0]),
            Ok((
                "1.10.0".into(),
                "https://api.github.com/repos/Light505/gswitchtool/releases/assets/2".into()
            ))
        );
        assert_eq!(
            previous_release(&releases, [1, 9, 0]),
            Err(AppUpdateFailure::NoPreviousRelease)
        );
        assert_eq!(
            previous_release(&[], [1, 11, 0]),
            Err(AppUpdateFailure::NoPreviousRelease)
        );
    }

    #[test]
    fn rollback_does_not_skip_a_missing_or_untrusted_selected_manifest() {
        let mut missing = release("v1.10.0");
        missing.assets.clear();
        assert_eq!(
            previous_release(&[release("v1.9.0"), missing], [1, 11, 0]),
            Err(AppUpdateFailure::Unavailable)
        );
        let mut untrusted = release("v1.10.0");
        untrusted.assets[0].url = "https://example.com/latest.json".into();
        assert_eq!(
            previous_release(&[release("v1.9.0"), untrusted], [1, 11, 0]),
            Err(AppUpdateFailure::UntrustedRelease)
        );
    }

    #[test]
    fn rollback_comparator_accepts_only_the_selected_manifest_version() {
        for version in ["1.7.0", "1.6.0", "1.8.0", "1.7.0-beta.1", "1.7.0+other"] {
            let manifest = serde_json::from_value(serde_json::json!({
                "version": version, "platforms": {}
            }))
            .expect("updater manifest");
            assert_eq!(
                rollback_target_matches("1.7.0", &manifest),
                version == "1.7.0",
                "{version}"
            );
        }
    }

    #[test]
    fn the_credential_may_go_only_to_this_repositorys_release_assets() {
        assert!(is_release_asset(
            "https://api.github.com/repos/Light505/gswitchtool/releases/assets/123456"
        ));
        for url in [
            "https://api.github.com/repos/Light505/gswitchtool/releases/assets/",
            "https://api.github.com/repos/Light505/gswitchtool/releases/assets/1/../2",
            "https://api.github.com/repos/someone/else/releases/assets/123",
            "https://github.com/Light505/gswitchtool/releases/download/v1.1.0/x.exe",
            "https://api.github.com.evil.example/repos/Light505/gswitchtool/releases/assets/1",
            "http://api.github.com/repos/Light505/gswitchtool/releases/assets/1",
        ] {
            assert!(!is_release_asset(url), "{url}");
        }
    }

    #[test]
    fn the_manifest_is_the_releases_latest_json_asset() {
        let release: Release = serde_json::from_value(serde_json::json!({
            "assets": [
                { "name": "GSwitch Claude Tool_1.1.0_x64-setup.exe", "url": "https://api.github.com/repos/Light505/gswitchtool/releases/assets/1" },
                { "name": "latest.json", "url": "https://api.github.com/repos/Light505/gswitchtool/releases/assets/2" }
            ]
        }))
        .expect("release");
        assert_eq!(
            manifest_url(&release).as_deref(),
            Ok("https://api.github.com/repos/Light505/gswitchtool/releases/assets/2")
        );

        let elsewhere: Release = serde_json::from_value(serde_json::json!({
            "assets": [{ "name": "latest.json", "url": "https://example.com/latest.json" }]
        }))
        .expect("release");
        assert_eq!(
            manifest_url(&elsewhere),
            Err(AppUpdateFailure::UntrustedRelease)
        );
        let missing: Release =
            serde_json::from_value(serde_json::json!({ "assets": [] })).expect("release");
        assert_eq!(manifest_url(&missing), Err(AppUpdateFailure::Unavailable));
    }

    /// Needs a saved GitHub sign-in that can read the repository. Run with
    /// `--ignored`; it reads the latest release and changes nothing.
    #[test]
    #[ignore]
    fn the_saved_git_sign_in_reads_the_private_repositorys_latest_release() {
        let token = github_token().expect("saved GitHub sign-in");
        match latest_manifest_url(&token).expect("repository readable") {
            None => {}
            Some(url) => assert!(is_release_asset(&url), "{url}"),
        }
        assert_eq!(
            latest_manifest_url("not-a-valid-token"),
            Err(AppUpdateFailure::GithubAccessDenied)
        );
    }

    #[test]
    fn reads_only_the_password_from_git_credential_output() {
        assert_eq!(
            credential_password(
                "protocol=https\nhost=github.com\nusername=me\npassword=gho_example\n"
            )
            .as_deref(),
            Some("gho_example")
        );
        assert_eq!(
            credential_password("protocol=https\nhost=github.com\n"),
            None
        );
        assert_eq!(credential_password("password=\n"), None);
    }

    #[test]
    fn progress_events_match_the_tauri_updater_shape() {
        assert_eq!(
            serde_json::to_value(DownloadEvent::Started {
                content_length: Some(10)
            })
            .expect("json"),
            serde_json::json!({ "event": "Started", "data": { "contentLength": 10 } })
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Progress { chunk_length: 4 }).expect("json"),
            serde_json::json!({ "event": "Progress", "data": { "chunkLength": 4 } })
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Finished).expect("json"),
            serde_json::json!({ "event": "Finished" })
        );
    }
}
