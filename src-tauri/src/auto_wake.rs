//! Automatic Wake for Invoke Mode (added by Light505 for gswitchtool). A Codex
//! usage window starts counting at the first model request after it resets;
//! until then it reports its full length as remaining, its reset time moving
//! with every read. When the user turns this on, GSwitch sends each allowed
//! account whose window is idle the same single short Wake request a person
//! can send, so its reset timer is already running when the account is needed.

use std::{
    collections::HashMap,
    thread,
    time::{Duration, Instant},
};

use crate::{
    accounts::AppState,
    invoke::InvokeState,
    quota,
    types::{AccountKind, AccountView, QuotaBucketKind, QuotaSnapshot},
    wake,
};

/// How often allowed accounts are checked.
const CHECK_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// The first check waits for the app to settle after starting.
const FIRST_CHECK: Duration = Duration::from_secs(60);
/// An account is woken at most this often, even if a Wake failed.
const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// A window with at least its full length minus this left has not started.
/// It also absorbs the provider's clock running ahead of this computer's.
const IDLE_MARGIN_SECS: i64 = 2 * 60;

/// Called with the account IDs an automatic Wake was started for.
pub type WokeCallback = Box<dyn Fn(&[String]) + Send>;

/// Runs automatic Wake for the life of the app.
pub fn start(state: AppState, invoke: InvokeState, on_woke: WokeCallback) {
    thread::spawn(move || {
        let mut attempts = HashMap::new();
        thread::sleep(FIRST_CHECK);
        loop {
            check(&state, &invoke, &mut attempts, &on_woke);
            thread::sleep(CHECK_INTERVAL);
        }
    });
}

fn check(
    state: &AppState,
    invoke: &InvokeState,
    attempts: &mut HashMap<String, Instant>,
    on_woke: &WokeCallback,
) {
    let Ok(settings) = invoke.settings() else {
        return;
    };
    if !settings.invoke_mode || !settings.auto_wake {
        return;
    }
    let accounts = state.list().unwrap_or_default();
    let candidates = accounts
        .iter()
        .filter(|account| wakeable(account))
        .filter(|account| {
            attempts
                .get(&account.id)
                .is_none_or(|at| at.elapsed() >= RETRY_INTERVAL)
        })
        .collect::<Vec<_>>();
    let mut idle = Vec::new();
    for account in candidates {
        // The same snapshot read as an automatic quota refresh: no refresh
        // of the sign-in, and the result updates the card.
        let snapshot = quota::refresh_quota_background(state, &account.id)
            .ok()
            .and_then(|view| view.snapshot);
        if snapshot.as_ref().is_some_and(has_idle_window) {
            idle.push(account.id.clone());
        }
    }
    if idle.is_empty() {
        return;
    }
    for id in &idle {
        attempts.insert(id.clone(), Instant::now());
    }
    if wake::start_selected(state.clone(), idle.clone()).is_ok() {
        on_woke(&idle);
    }
}

/// Allowed in Invoke Mode, a signed-in ChatGPT sign-in.
fn wakeable(account: &AccountView) -> bool {
    account.invoke_allowed && account.kind == AccountKind::ChatGpt && !account.sign_in_required
}

/// True when a Codex usage window has not started: nothing used, and its full
/// length still ahead of the moment it was read.
pub(crate) fn has_idle_window(snapshot: &QuotaSnapshot) -> bool {
    let read_at = snapshot.fetched_at_unix_ms / 1000;
    snapshot
        .buckets
        .iter()
        .filter(|bucket| {
            bucket.kind == QuotaBucketKind::Codex && bucket.rate_limit_reached_type.is_none()
        })
        .flat_map(|bucket| &bucket.windows)
        .any(|window| {
            let (Some(minutes), Some(resets_at)) = (window.window_duration_mins, window.resets_at)
            else {
                return false;
            };
            window.used_percent.unwrap_or(0) == 0
                && resets_at - read_at >= minutes * 60 - IDLE_MARGIN_SECS
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{QuotaBucket, QuotaWindow, QuotaWindowKind};

    const READ_AT: i64 = 1_800_000_000;

    fn snapshot(windows: &[(i64, u8, i64)]) -> QuotaSnapshot {
        QuotaSnapshot {
            fetched_at_unix_ms: READ_AT * 1000,
            account_id: None,
            ordinary_usage_allowed: None,
            buckets: vec![QuotaBucket {
                limit_id: "codex".into(),
                limit_name: None,
                plan_type: None,
                rate_limit_reached_type: None,
                kind: QuotaBucketKind::Codex,
                windows: windows
                    .iter()
                    .map(|(minutes, used, resets_in)| QuotaWindow {
                        kind: QuotaWindowKind::FiveHour,
                        used_percent: Some(*used),
                        remaining_percent: Some(100 - used),
                        window_duration_mins: Some(*minutes),
                        resets_at: Some(READ_AT + resets_in),
                    })
                    .collect(),
            }],
            reset_credits: None,
        }
    }

    #[test]
    fn an_unstarted_window_reports_its_full_length_and_nothing_used() {
        // Read on an idle account: resets five hours (plus the provider's
        // clock lead) after the read.
        assert!(has_idle_window(&snapshot(&[(300, 0, 300 * 60 + 20)])));
        // A weekly window that has not started counts too.
        assert!(has_idle_window(&snapshot(&[
            (300, 4, 3_000),
            (10_080, 0, 10_080 * 60)
        ])));
    }

    #[test]
    fn a_running_or_used_window_is_left_alone() {
        // Started 40 minutes ago, nothing measurable used yet.
        assert!(!has_idle_window(&snapshot(&[(300, 0, 260 * 60)])));
        // Used, even with its full length left.
        assert!(!has_idle_window(&snapshot(&[(300, 1, 300 * 60)])));
        // Running windows on both limits.
        assert!(!has_idle_window(&snapshot(&[
            (300, 30, 9_000),
            (10_080, 55, 300_000)
        ])));
        // An exhausted bucket is never woken.
        let mut limited = snapshot(&[(300, 0, 300 * 60)]);
        limited.buckets[0].rate_limit_reached_type = Some("rate_limit_reached".into());
        assert!(!has_idle_window(&limited));
        // Without a reset time nothing can be told.
        let mut unknown = snapshot(&[(300, 0, 300 * 60)]);
        unknown.buckets[0].windows[0].resets_at = None;
        assert!(!has_idle_window(&unknown));
    }

    #[test]
    fn only_allowed_signed_in_chatgpt_accounts_are_woken() {
        let account = |allowed: bool, kind: AccountKind, signed_out: bool| AccountView {
            id: "a".into(),
            label: "a".into(),
            kind,
            email: None,
            plan_type: None,
            workspace_name: None,
            active: false,
            needs_apply: false,
            sign_in_required: signed_out,
            revision: 1,
            invoke_allowed: allowed,
        };
        assert!(wakeable(&account(true, AccountKind::ChatGpt, false)));
        assert!(!wakeable(&account(false, AccountKind::ChatGpt, false)));
        assert!(!wakeable(&account(true, AccountKind::ApiKey, false)));
        assert!(!wakeable(&account(true, AccountKind::ChatGpt, true)));
    }
}
