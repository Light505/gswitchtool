//! Account-wide failover for Invoke Mode. Claude Code's Codex workers report
//! what they observe; this module alone decides whether a failover happens,
//! stops the App Servers the workers registered, picks the replacement account,
//! and switches through the normal switch transaction. Workers then resume their
//! own Codex threads.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tokio::sync::watch;
use uuid::Uuid;

use crate::{
    accounts::AppState,
    invoke::InvokeState,
    quota, runtime, switching,
    types::{AccountKind, AccountView, QuotaBucketKind, QuotaSnapshot, SwitchFailureCode},
};

/// Why a failover, or a worker request about one, did not succeed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailoverCode {
    InvokeModeDisabled,
    /// GSwitch cannot tell which saved account Codex is using: it is not
    /// saved, Codex is signed out, or an earlier switch needs recovery.
    CurrentAccountUnknown,
    ExternalCodexRunning,
    CodexShutdownFailed,
    NoEligibleAccount,
    /// Invoke Mode is paused because no account had Codex usage left.
    InvokePaused,
    AccountSwitchFailed,
    AccountVerificationFailed,
    UnknownLease,
    Unavailable,
}

/// The reply to a usage-limit report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitAck {
    /// This report started the failover.
    Started,
    /// A failover for the same account was already running.
    Joined,
    /// The account was already replaced; resume without another switch.
    AlreadySwitched,
}

/// What a worker learns when its run ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunEnd {
    /// Nothing changed; a failed run failed on its own.
    Unchanged,
    /// A failover is running; wait for it before resuming.
    FailoverInProgress,
    /// The account changed since the run started; resume.
    AccountSwitched,
}

/// Invoke Mode starts no Codex work: a failover found no account GSwitch may
/// use with Codex usage left. The pause ends when the first of those accounts
/// resets, or when the user resumes Invoke Mode in GSwitch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InvokePause {
    /// Unix seconds; `None` when no reset time is known.
    pub resumes_at: Option<i64>,
}

/// The configuration a worker's Codex thread must keep across a failover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseRequest {
    pub model: String,
    pub reasoning_effort: String,
    pub write: bool,
    pub cwd: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunState {
    Idle,
    /// Allowed to start; its App Server is not registered yet.
    Starting,
    Running(u32),
}

/// A worker as reported to the Claude Code integration. It holds no
/// credentials or account identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkerView {
    pub model: String,
    pub reasoning_effort: String,
    pub write: bool,
    pub cwd: String,
    pub thread_id: Option<String>,
    pub running: bool,
}

struct Lease {
    connection: u64,
    request: LeaseRequest,
    run: RunState,
    /// The account that was active when the current or last run started.
    account: Option<String>,
    thread_id: Option<String>,
}

#[derive(Default)]
struct Inner {
    leases: HashMap<String, Lease>,
    /// The account being replaced while a failover runs.
    replacing: Option<String>,
    /// The last finished failover. Workers resume only after a recorded
    /// success for their own account.
    last_outcome: Option<FailoverOutcome>,
    /// Set while a failover waits for the user to close Codex.
    waiting_for_codex: Option<SwitchAccounts>,
    cancel_requested: bool,
    paused: Option<InvokePause>,
}

struct FailoverOutcome {
    replaced: String,
    result: Result<(), FailoverCode>,
    /// The switch transaction's own reason when it refused, for diagnosis.
    detail: Option<String>,
}

/// A refused switch: the failover code plus the switch transaction's reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchRefusal {
    pub code: FailoverCode,
    pub detail: Option<String>,
}

impl From<FailoverCode> for SwitchRefusal {
    fn from(code: FailoverCode) -> Self {
        Self { code, detail: None }
    }
}

/// The accounts a failover replaces and switches to, by saved-account ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SwitchAccounts {
    pub from: String,
    pub to: String,
}

/// Operating-system, provider, and account effects of a failover. The real
/// implementation is `AppOps`; tests substitute deterministic doubles.
pub trait FailoverOps: Send + Sync {
    fn invoke_mode(&self) -> bool;
    fn active_account(&self) -> Option<String>;
    fn accounts(&self) -> Vec<AccountView>;
    fn read_quota(&self, account_id: &str) -> Option<QuotaSnapshot>;
    fn switch_to(&self, account_id: &str) -> Result<(), SwitchRefusal>;
    fn terminate(&self, pid: u32);
    fn alive(&self, pid: u32) -> bool;
    fn other_codex_running(&self) -> bool;
    /// Asks the user to close Codex (`Some`) or withdraws that request.
    fn waiting_for_codex(&self, accounts: Option<&SwitchAccounts>);
    fn switched(&self, from: &str, to: &str);
    /// Reports that Invoke Mode paused (`Some`) or was resumed.
    fn paused(&self, pause: Option<&InvokePause>);
    fn now_unix(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or_default()
    }
}

#[derive(Clone, Copy)]
pub struct Timings {
    /// How long a started run may take to register its App Server.
    pub start_grace: Duration,
    /// How long stopped App Servers may take to exit.
    pub shutdown: Duration,
    /// How long a worker waits for a running failover.
    pub wait: Duration,
    /// How long a failover waits for the user to close Codex.
    pub user_close: Duration,
    pub poll: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            start_grace: Duration::from_secs(10),
            shutdown: Duration::from_secs(10),
            wait: Duration::from_secs(15 * 60),
            user_close: Duration::from_secs(10 * 60),
            poll: Duration::from_millis(100),
        }
    }
}

pub struct Coordinator {
    inner: Mutex<Inner>,
    changed: watch::Sender<u64>,
    ops: Arc<dyn FailoverOps>,
    timings: Timings,
}

impl Coordinator {
    pub fn new(ops: Arc<dyn FailoverOps>, timings: Timings) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            changed: watch::channel(0).0,
            ops,
            timings,
        })
    }

    /// Returns (workers running, failover in progress).
    pub fn status(&self) -> (usize, bool) {
        let inner = self.lock();
        let running = inner
            .leases
            .values()
            .filter(|lease| lease.run != RunState::Idle)
            .count();
        (running, inner.replacing.is_some())
    }

    pub fn workers(&self) -> Vec<WorkerView> {
        let inner = self.lock();
        let mut workers = inner
            .leases
            .values()
            .map(|lease| WorkerView {
                model: lease.request.model.clone(),
                reasoning_effort: lease.request.reasoning_effort.clone(),
                write: lease.request.write,
                cwd: lease.request.cwd.clone(),
                thread_id: lease.thread_id.clone(),
                running: lease.run != RunState::Idle,
            })
            .collect::<Vec<_>>();
        workers.sort_by(|left, right| {
            left.cwd
                .cmp(&right.cwd)
                .then(left.thread_id.cmp(&right.thread_id))
        });
        workers
    }

    pub fn open_lease(&self, connection: u64, request: LeaseRequest) -> String {
        let id = Uuid::new_v4().to_string();
        self.lock().leases.insert(
            id.clone(),
            Lease {
                connection,
                request,
                run: RunState::Idle,
                account: None,
                thread_id: None,
            },
        );
        self.notify();
        id
    }

    /// Lets a worker start Codex once no failover is running.
    pub async fn begin_run(&self, lease_id: &str) -> Result<(), FailoverCode> {
        self.wait_until(|inner| {
            if !inner.leases.contains_key(lease_id) {
                return Err(FailoverCode::UnknownLease);
            }
            if inner.replacing.is_some() {
                return Ok(None);
            }
            if self.current_pause(inner).is_some() {
                return Err(FailoverCode::InvokePaused);
            }
            let lease = inner
                .leases
                .get_mut(lease_id)
                .ok_or(FailoverCode::UnknownLease)?;
            lease.run = RunState::Starting;
            lease.account = self.ops.active_account();
            Ok(Some(()))
        })
        .await
    }

    /// Records the worker's App Server. One that starts during a failover is
    /// stopped at once; its run fails and the worker waits for the failover.
    pub fn record_app_server(&self, lease_id: &str, pid: u32) -> Result<(), FailoverCode> {
        let mut inner = self.lock();
        let replacing = inner.replacing.is_some();
        let lease = inner
            .leases
            .get_mut(lease_id)
            .ok_or(FailoverCode::UnknownLease)?;
        if replacing {
            lease.run = RunState::Idle;
            drop(inner);
            self.ops.terminate(pid);
        } else {
            lease.run = RunState::Running(pid);
        }
        self.notify();
        Ok(())
    }

    pub fn record_thread(&self, lease_id: &str, thread_id: String) -> Result<(), FailoverCode> {
        let mut inner = self.lock();
        let lease = inner
            .leases
            .get_mut(lease_id)
            .ok_or(FailoverCode::UnknownLease)?;
        lease.thread_id = Some(thread_id);
        Ok(())
    }

    pub fn end_run(&self, lease_id: &str) -> Result<RunEnd, FailoverCode> {
        let mut inner = self.lock();
        let replacing = inner.replacing.is_some();
        let lease = inner
            .leases
            .get_mut(lease_id)
            .ok_or(FailoverCode::UnknownLease)?;
        lease.run = RunState::Idle;
        let account = lease.account.clone();
        drop(inner);
        self.notify();
        Ok(if replacing {
            RunEnd::FailoverInProgress
        } else if switched_away(account.as_deref(), self.ops.active_account().as_deref()) {
            RunEnd::AccountSwitched
        } else {
            RunEnd::Unchanged
        })
    }

    /// Handles Codex's structured usage-limit report. Only one failover runs
    /// at a time; reports about the same account join it.
    pub fn report_limit(self: &Arc<Self>, lease_id: &str) -> Result<LimitAck, FailoverCode> {
        let mut inner = self.lock();
        let account = inner
            .leases
            .get(lease_id)
            .ok_or(FailoverCode::UnknownLease)?
            .account
            .clone();
        if inner.replacing.is_some() {
            return Ok(LimitAck::Joined);
        }
        if self.current_pause(&mut inner).is_some() {
            return Err(FailoverCode::InvokePaused);
        }
        // An unknown live account is never mistaken for a completed switch.
        let live = self
            .ops
            .active_account()
            .ok_or(FailoverCode::CurrentAccountUnknown)?;
        if account.as_deref() != Some(live.as_str()) {
            return Ok(LimitAck::AlreadySwitched);
        }
        if !self.ops.invoke_mode() {
            return Err(FailoverCode::InvokeModeDisabled);
        }
        let exhausted = live;
        inner.replacing = Some(exhausted.clone());
        inner.last_outcome = None;
        drop(inner);
        self.notify();

        let coordinator = Arc::clone(self);
        std::thread::spawn(move || {
            let result = coordinator.run_failover(&exhausted);
            let mut inner = coordinator.lock();
            inner.replacing = None;
            let (result, detail) = match result {
                Ok(()) => (Ok(()), None),
                Err(refusal) => (Err(refusal.code), refusal.detail),
            };
            inner.last_outcome = Some(FailoverOutcome {
                replaced: exhausted,
                result,
                detail,
            });
            drop(inner);
            coordinator.notify();
        });
        Ok(LimitAck::Started)
    }

    /// Waits for the running failover. Succeeds only when the worker's account
    /// was replaced, so it never resumes under an unverified identity.
    pub async fn await_failover(&self, lease_id: &str) -> Result<(), FailoverCode> {
        self.wait_until(|inner| {
            let account = inner
                .leases
                .get(lease_id)
                .ok_or(FailoverCode::UnknownLease)?
                .account
                .clone();
            if inner.replacing.is_some() {
                return Ok(None);
            }
            match &inner.last_outcome {
                Some(outcome) if Some(&outcome.replaced) == account.as_ref() => {
                    outcome.result.map(Some)
                }
                // Another way the account changed: resume only when the live
                // account is known and differs from the one this run used.
                _ if switched_away(account.as_deref(), self.ops.active_account().as_deref()) => {
                    Ok(Some(()))
                }
                _ => Err(FailoverCode::Unavailable),
            }
        })
        .await
    }

    /// The current pause, if Invoke Mode is paused.
    pub fn pause(&self) -> Option<InvokePause> {
        let mut inner = self.lock();
        self.current_pause(&mut inner)
    }

    /// The user resumed Invoke Mode in GSwitch, or changed what it may use.
    pub fn resume(&self) {
        if self.lock().paused.take().is_some() {
            self.ops.paused(None);
            self.notify();
        }
    }

    /// A pause past its reset time is over.
    fn current_pause(&self, inner: &mut Inner) -> Option<InvokePause> {
        if let Some(InvokePause {
            resumes_at: Some(at),
        }) = inner.paused
        {
            if self.ops.now_unix() >= at {
                inner.paused = None;
            }
        }
        inner.paused.clone()
    }

    /// The switch transaction's reason for the last failed failover, if any.
    pub fn last_failure_detail(&self) -> Option<String> {
        self.lock()
            .last_outcome
            .as_ref()
            .filter(|outcome| outcome.result.is_err())
            .and_then(|outcome| outcome.detail.clone())
    }

    /// Forgets a worker whose connection closed and stops an App Server it
    /// left behind.
    pub fn drop_connection(&self, connection: u64) {
        let mut inner = self.lock();
        let orphaned = inner
            .leases
            .values()
            .filter(|lease| lease.connection == connection)
            .filter_map(|lease| match lease.run {
                RunState::Running(pid) => Some(pid),
                _ => None,
            })
            .collect::<Vec<_>>();
        inner
            .leases
            .retain(|_, lease| lease.connection != connection);
        drop(inner);
        for pid in orphaned {
            self.ops.terminate(pid);
        }
        self.notify();
    }

    fn run_failover(&self, exhausted: &str) -> Result<(), SwitchRefusal> {
        // Quiesce: give runs that were already allowed to start a moment to
        // register their App Server, then stop every registered one.
        let grace = Instant::now() + self.timings.start_grace;
        while Instant::now() < grace
            && self
                .lock()
                .leases
                .values()
                .any(|lease| lease.run == RunState::Starting)
        {
            std::thread::sleep(self.timings.poll);
        }
        let pids = self
            .lock()
            .leases
            .values()
            .filter_map(|lease| match lease.run {
                RunState::Running(pid) => Some(pid),
                _ => None,
            })
            .collect::<Vec<_>>();
        for pid in &pids {
            self.ops.terminate(*pid);
        }
        let deadline = Instant::now() + self.timings.shutdown;
        while pids.iter().any(|pid| self.ops.alive(*pid)) {
            if Instant::now() >= deadline {
                return Err(FailoverCode::CodexShutdownFailed.into());
            }
            std::thread::sleep(self.timings.poll);
        }
        // Select: only human-allowed accounts, read fresh, never the one that
        // just ran out. Choosing first means the user is never asked to close
        // Codex when no account could take over.
        if !self.ops.invoke_mode() {
            return Err(FailoverCode::InvokeModeDisabled.into());
        }
        let candidates = self
            .ops
            .accounts()
            .into_iter()
            .filter(|account| eligible(account, exhausted))
            .map(|account| {
                let quota = self.ops.read_quota(&account.id);
                (account, quota)
            })
            .collect::<Vec<_>>();
        let Some(target) = select_account(&candidates, exhausted) else {
            // Nothing can take over: pause until the first of these accounts,
            // or the one that ran out, can use Codex again.
            let mut quotas = candidates
                .into_iter()
                .map(|(_, quota)| quota)
                .collect::<Vec<_>>();
            quotas.push(self.ops.read_quota(exhausted));
            let pause = InvokePause {
                resumes_at: earliest_reset(&quotas),
            };
            self.lock().paused = Some(pause.clone());
            self.ops.paused(Some(&pause));
            return Err(FailoverCode::NoEligibleAccount.into());
        };

        // Switch and verify through the normal transaction. A Codex the user
        // opened is never stopped: GSwitch asks the user to close it and waits.
        let accounts = SwitchAccounts {
            from: exhausted.to_string(),
            to: target.clone(),
        };
        loop {
            self.wait_for_codex_to_close(&accounts)?;
            match self.ops.switch_to(&target) {
                Err(refusal) if refusal.code == FailoverCode::ExternalCodexRunning => continue,
                result => result?,
            }
            self.ops.switched(exhausted, &target);
            return Ok(());
        }
    }

    fn wait_for_codex_to_close(&self, accounts: &SwitchAccounts) -> Result<(), FailoverCode> {
        if !self.ops.other_codex_running() {
            return Ok(());
        }
        {
            let mut inner = self.lock();
            inner.waiting_for_codex = Some(accounts.clone());
            inner.cancel_requested = false;
        }
        self.ops.waiting_for_codex(Some(accounts));
        self.notify();
        let deadline = Instant::now() + self.timings.user_close;
        let result = loop {
            if self.lock().cancel_requested || Instant::now() >= deadline {
                break Err(FailoverCode::ExternalCodexRunning);
            }
            if !self.ops.invoke_mode() {
                break Err(FailoverCode::InvokeModeDisabled);
            }
            if !self.ops.other_codex_running() {
                break Ok(());
            }
            std::thread::sleep(self.timings.poll);
        };
        {
            let mut inner = self.lock();
            inner.waiting_for_codex = None;
            inner.cancel_requested = false;
        }
        self.ops.waiting_for_codex(None);
        self.notify();
        result
    }

    /// The switch waiting for the user to close Codex, if any.
    pub fn waiting_for_codex(&self) -> Option<SwitchAccounts> {
        self.lock().waiting_for_codex.clone()
    }

    /// The user declined to close Codex; the failover ends without a switch.
    pub fn cancel_waiting_failover(&self) {
        let mut inner = self.lock();
        if inner.waiting_for_codex.is_some() {
            inner.cancel_requested = true;
        }
    }

    async fn wait_until<T>(
        &self,
        mut check: impl FnMut(&mut Inner) -> Result<Option<T>, FailoverCode>,
    ) -> Result<T, FailoverCode> {
        let mut changes = self.changed.subscribe();
        let deadline = tokio::time::Instant::now() + self.timings.wait;
        loop {
            if let Some(value) = check(&mut self.lock())? {
                return Ok(value);
            }
            match tokio::time::timeout_at(deadline, changes.changed()).await {
                Ok(Ok(())) => {}
                _ => return Err(FailoverCode::Unavailable),
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self) {
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }
}

/// True only when the live account is known and is not the one the run used.
fn switched_away(run_account: Option<&str>, live: Option<&str>) -> bool {
    live.is_some() && live != run_account
}

fn eligible(account: &AccountView, exhausted: &str) -> bool {
    account.id != exhausted
        && account.invoke_allowed
        && account.kind == AccountKind::ChatGpt
        && !account.sign_in_required
}

/// Picks the eligible account with the most usable capacity: the smallest
/// remaining percentage across its Codex windows. Ties keep account order.
fn select_account(
    candidates: &[(AccountView, Option<QuotaSnapshot>)],
    exhausted: &str,
) -> Option<String> {
    let mut best: Option<(u8, &str)> = None;
    for (account, quota) in candidates {
        if !eligible(account, exhausted) {
            continue;
        }
        let Some(score) = quota.as_ref().and_then(usable_capacity) else {
            continue;
        };
        if best.is_none_or(|(best_score, _)| score > best_score) {
            best = Some((score, &account.id));
        }
    }
    best.map(|(_, id)| id.to_string())
}

/// The provider's own permission decides when it is reported; any Codex
/// window at zero or a reported limit makes the account unusable.
fn usable_capacity(snapshot: &QuotaSnapshot) -> Option<u8> {
    if snapshot.ordinary_usage_allowed == Some(false) {
        return None;
    }
    let codex = snapshot
        .buckets
        .iter()
        .filter(|bucket| bucket.kind == QuotaBucketKind::Codex)
        .collect::<Vec<_>>();
    if codex
        .iter()
        .any(|bucket| bucket.rate_limit_reached_type.is_some())
    {
        return None;
    }
    let remaining = codex
        .iter()
        .flat_map(|bucket| &bucket.windows)
        .filter_map(|window| window.remaining_percent)
        .collect::<Vec<_>>();
    if remaining.contains(&0) {
        return None;
    }
    match (snapshot.ordinary_usage_allowed, remaining.iter().min()) {
        (_, Some(minimum)) => Some(*minimum),
        (Some(true), None) => Some(0),
        (_, None) => None,
    }
}

/// When the first of these accounts can use Codex again: each account's
/// latest reset among its spent Codex windows, then the earliest account.
fn earliest_reset(quotas: &[Option<QuotaSnapshot>]) -> Option<i64> {
    quotas.iter().flatten().filter_map(account_reset).min()
}

/// `None` when a spent window has no reset time or nothing shows as spent.
fn account_reset(snapshot: &QuotaSnapshot) -> Option<i64> {
    let mut latest = None;
    for bucket in snapshot
        .buckets
        .iter()
        .filter(|bucket| bucket.kind == QuotaBucketKind::Codex)
    {
        let spent = bucket
            .windows
            .iter()
            .filter(|window| window.remaining_percent == Some(0))
            .collect::<Vec<_>>();
        // A reported limit without a spent window blocks until all reset.
        let blocking = if spent.is_empty() && bucket.rate_limit_reached_type.is_some() {
            bucket.windows.iter().collect()
        } else {
            spent
        };
        for window in blocking {
            latest = latest.max(Some(window.resets_at?));
        }
    }
    latest
}

/// Called with the replaced and the new account ID after a verified switch.
pub type SwitchedCallback = Box<dyn Fn(&str, &str) + Send + Sync>;

/// Called when a failover starts or stops waiting for the user to close Codex.
pub type WaitingCallback = Box<dyn Fn(Option<&SwitchAccounts>) + Send + Sync>;

/// Called when Invoke Mode pauses or resumes.
pub type PausedCallback = Box<dyn Fn(Option<&InvokePause>) + Send + Sync>;

/// The real failover effects: GSwitch's account store, provider reads, the
/// switch transaction, and process control limited to registered PIDs.
pub struct AppOps {
    pub state: AppState,
    pub invoke: InvokeState,
    pub on_switched: SwitchedCallback,
    pub on_waiting: WaitingCallback,
    pub on_paused: PausedCallback,
}

impl FailoverOps for AppOps {
    fn invoke_mode(&self) -> bool {
        self.invoke
            .settings()
            .map(|settings| settings.invoke_mode)
            .unwrap_or(false)
    }

    // The saved account Codex is signed in to now. GSwitch's own active
    // record is set only by a switch made in GSwitch, so it can be empty.
    fn active_account(&self) -> Option<String> {
        switching::live_account(&self.state)
            .ok()?
            .account
            .map(|account| account.id)
    }

    fn accounts(&self) -> Vec<AccountView> {
        self.state.list().unwrap_or_default()
    }

    // The same read as a user's Refresh, which may use the official token
    // refresh for an inactive saved sign-in. No Codex is running here.
    fn read_quota(&self, account_id: &str) -> Option<QuotaSnapshot> {
        quota::refresh_quota(&self.state, account_id)
            .ok()
            .and_then(|view| view.snapshot)
    }

    fn switch_to(&self, account_id: &str) -> Result<(), SwitchRefusal> {
        switching::switch_account(&self.state, account_id)
            .map(|_| ())
            .map_err(|failure| SwitchRefusal {
                code: match failure.code {
                    SwitchFailureCode::CodexOpen => FailoverCode::ExternalCodexRunning,
                    SwitchFailureCode::PostWriteVerificationFailed
                    | SwitchFailureCode::VerificationFailed
                    | SwitchFailureCode::LocalVerificationFailed
                    | SwitchFailureCode::TargetWorkspaceMismatch => {
                        FailoverCode::AccountVerificationFailed
                    }
                    _ => FailoverCode::AccountSwitchFailed,
                },
                detail: serde_json::to_value(failure.code)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string)),
            })
    }

    fn terminate(&self, pid: u32) {
        runtime::terminate_process_tree(pid);
    }

    fn alive(&self, pid: u32) -> bool {
        runtime::process_alive(pid)
    }

    fn other_codex_running(&self) -> bool {
        runtime::external_codex_running(&[]).unwrap_or(true)
    }

    fn waiting_for_codex(&self, accounts: Option<&SwitchAccounts>) {
        (self.on_waiting)(accounts);
    }

    fn switched(&self, from: &str, to: &str) {
        (self.on_switched)(from, to);
    }

    fn paused(&self, pause: Option<&InvokePause>) {
        (self.on_paused)(pause);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{QuotaBucket, QuotaWindow, QuotaWindowKind};
    use std::collections::HashSet;

    #[derive(Default)]
    struct World {
        invoke_mode: bool,
        active: Option<String>,
        accounts: Vec<AccountView>,
        quotas: HashMap<String, QuotaSnapshot>,
        switch_result: Option<FailoverCode>,
        /// A refused switch leaves the live account unidentifiable, as a
        /// pending switch record does.
        unknown_after_refusal: bool,
        switches: Vec<String>,
        alive: HashSet<u32>,
        terminated: Vec<u32>,
        stubborn: HashSet<u32>,
        other_codex: bool,
        quota_reads: Vec<String>,
        waiting_events: Vec<Option<SwitchAccounts>>,
        pause_events: Vec<Option<InvokePause>>,
        now: i64,
    }

    struct FakeOps(Mutex<World>);

    impl FakeOps {
        fn world(&self) -> std::sync::MutexGuard<'_, World> {
            self.0.lock().expect("world")
        }
    }

    impl FailoverOps for FakeOps {
        fn invoke_mode(&self) -> bool {
            self.world().invoke_mode
        }
        fn active_account(&self) -> Option<String> {
            self.world().active.clone()
        }
        fn accounts(&self) -> Vec<AccountView> {
            self.world().accounts.clone()
        }
        fn read_quota(&self, account_id: &str) -> Option<QuotaSnapshot> {
            let mut world = self.world();
            world.quota_reads.push(account_id.to_string());
            world.quotas.get(account_id).cloned()
        }
        fn switch_to(&self, account_id: &str) -> Result<(), SwitchRefusal> {
            let mut world = self.world();
            world.switches.push(account_id.to_string());
            match world.switch_result {
                Some(code) => {
                    if world.unknown_after_refusal {
                        world.active = None;
                    }
                    Err(SwitchRefusal {
                        code,
                        detail: Some("recovery_required".into()),
                    })
                }
                None => {
                    world.active = Some(account_id.to_string());
                    Ok(())
                }
            }
        }
        fn terminate(&self, pid: u32) {
            let mut world = self.world();
            world.terminated.push(pid);
            if !world.stubborn.contains(&pid) {
                world.alive.remove(&pid);
            }
        }
        fn alive(&self, pid: u32) -> bool {
            self.world().alive.contains(&pid)
        }
        fn other_codex_running(&self) -> bool {
            self.world().other_codex
        }
        fn waiting_for_codex(&self, accounts: Option<&SwitchAccounts>) {
            self.world().waiting_events.push(accounts.cloned());
        }
        fn switched(&self, _from: &str, _to: &str) {}
        fn paused(&self, pause: Option<&InvokePause>) {
            self.world().pause_events.push(pause.cloned());
        }
        fn now_unix(&self) -> i64 {
            self.world().now
        }
    }

    fn account(id: &str, allowed: bool) -> AccountView {
        AccountView {
            id: id.into(),
            label: id.into(),
            kind: AccountKind::ChatGpt,
            email: Some(format!("{id}@example.com")),
            plan_type: None,
            workspace_name: None,
            active: false,
            needs_apply: false,
            sign_in_required: false,
            revision: 1,
            invoke_allowed: allowed,
        }
    }

    fn quota(five_hour: u8, weekly: u8) -> QuotaSnapshot {
        let window = |kind, remaining: u8| QuotaWindow {
            kind,
            used_percent: Some(100 - remaining),
            remaining_percent: Some(remaining),
            window_duration_mins: None,
            resets_at: None,
        };
        QuotaSnapshot {
            fetched_at_unix_ms: 1,
            account_id: None,
            ordinary_usage_allowed: None,
            buckets: vec![QuotaBucket {
                limit_id: "codex".into(),
                limit_name: None,
                plan_type: None,
                rate_limit_reached_type: None,
                kind: QuotaBucketKind::Codex,
                windows: vec![
                    window(QuotaWindowKind::FiveHour, five_hour),
                    window(QuotaWindowKind::Weekly, weekly),
                ],
            }],
            reset_credits: None,
        }
    }

    fn fast() -> Timings {
        Timings {
            start_grace: Duration::from_millis(300),
            shutdown: Duration::from_millis(300),
            wait: Duration::from_secs(5),
            user_close: Duration::from_secs(3),
            poll: Duration::from_millis(10),
        }
    }

    /// Account A is active and exhausted; B and C are allowed with quota.
    fn world() -> World {
        World {
            invoke_mode: true,
            active: Some("a".into()),
            accounts: vec![account("a", true), account("b", true), account("c", true)],
            quotas: HashMap::from([
                ("a".into(), quota(0, 90)),
                ("b".into(), quota(80, 30)),
                ("c".into(), quota(60, 70)),
            ]),
            ..World::default()
        }
    }

    fn setup(world: World) -> (Arc<Coordinator>, Arc<FakeOps>) {
        let ops = Arc::new(FakeOps(Mutex::new(world)));
        (Coordinator::new(ops.clone(), fast()), ops)
    }

    fn request(model: &str, effort: &str) -> LeaseRequest {
        LeaseRequest {
            model: model.into(),
            reasoning_effort: effort.into(),
            write: true,
            cwd: "/repo".into(),
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    /// Opens a lease, starts a run, and registers its App Server.
    fn running_worker(
        coordinator: &Coordinator,
        ops: &FakeOps,
        connection: u64,
        pid: u32,
    ) -> String {
        let lease = coordinator.open_lease(connection, request("model-a", "high"));
        block_on(coordinator.begin_run(&lease)).expect("begin");
        ops.world().alive.insert(pid);
        coordinator
            .record_app_server(&lease, pid)
            .expect("register");
        coordinator
            .record_thread(&lease, format!("thread-{pid}"))
            .expect("thread");
        lease
    }

    #[test]
    fn the_registry_keeps_each_workers_resume_configuration() {
        let (coordinator, ops) = setup(world());
        running_worker(&coordinator, &ops, 1, 1201);
        assert_eq!(
            coordinator.workers(),
            vec![WorkerView {
                model: "model-a".into(),
                reasoning_effort: "high".into(),
                write: true,
                cwd: "/repo".into(),
                thread_id: Some("thread-1201".into()),
                running: true,
            }]
        );
    }

    fn wait_for_failover(coordinator: &Coordinator) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while coordinator.status().1 {
            assert!(Instant::now() < deadline, "failover did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn selection_prefers_the_most_usable_capacity_and_keeps_order_on_ties() {
        let entries = vec![
            (account("b", true), Some(quota(80, 30))),
            (account("c", true), Some(quota(60, 70))),
        ];
        assert_eq!(select_account(&entries, "a").as_deref(), Some("c"));

        let tied = vec![
            (account("b", true), Some(quota(50, 50))),
            (account("c", true), Some(quota(50, 90))),
        ];
        assert_eq!(select_account(&tied, "a").as_deref(), Some("b"));
    }

    #[test]
    fn selection_never_picks_a_disallowed_exhausted_unknown_or_signed_out_account() {
        let mut signed_out = account("d", true);
        signed_out.sign_in_required = true;
        let mut api_key = account("e", true);
        api_key.kind = AccountKind::ApiKey;
        let mut denied = quota(90, 90);
        denied.ordinary_usage_allowed = Some(false);
        let entries = vec![
            (account("a", true), Some(quota(100, 100))),
            (account("b", false), Some(quota(100, 100))),
            (account("c", true), Some(quota(0, 100))),
            (signed_out, Some(quota(100, 100))),
            (api_key, Some(quota(100, 100))),
            (account("f", true), None),
            (account("g", true), Some(denied)),
        ];
        assert_eq!(select_account(&entries, "a"), None);
    }

    #[test]
    fn one_limit_with_several_workers_switches_once_and_stops_each_app_server() {
        let (coordinator, ops) = setup(world());
        let workers = [101, 102, 103]
            .iter()
            .enumerate()
            .map(|(index, pid)| running_worker(&coordinator, &ops, index as u64, *pid))
            .collect::<Vec<_>>();
        assert_eq!(coordinator.status(), (3, false));

        for worker in &workers {
            assert_eq!(coordinator.end_run(worker), Ok(RunEnd::Unchanged));
        }
        // Re-register so the failover has App Servers to stop.
        let workers = [201, 202, 203]
            .iter()
            .enumerate()
            .map(|(index, pid)| running_worker(&coordinator, &ops, 10 + index as u64, *pid))
            .collect::<Vec<_>>();

        assert_eq!(coordinator.report_limit(&workers[0]), Ok(LimitAck::Started));
        assert_eq!(coordinator.report_limit(&workers[1]), Ok(LimitAck::Joined));
        wait_for_failover(&coordinator);
        assert_eq!(
            coordinator.report_limit(&workers[2]),
            Ok(LimitAck::AlreadySwitched)
        );

        let world = ops.world();
        assert_eq!(world.switches, vec!["c".to_string()]);
        assert_eq!(world.active.as_deref(), Some("c"));
        let mut terminated = world.terminated.clone();
        terminated.sort_unstable();
        assert_eq!(terminated, vec![201, 202, 203]);
        assert!(!world.quota_reads.contains(&"a".to_string()));
        drop(world);
        for worker in &workers {
            assert_eq!(block_on(coordinator.await_failover(worker)), Ok(()));
        }
    }

    #[test]
    fn concurrent_reports_from_many_threads_cause_one_switch() {
        let (coordinator, ops) = setup(world());
        let workers = (0..8)
            .map(|index| running_worker(&coordinator, &ops, index, 300 + index as u32))
            .collect::<Vec<_>>();
        let handles = workers
            .iter()
            .cloned()
            .map(|worker| {
                let coordinator = Arc::clone(&coordinator);
                std::thread::spawn(move || coordinator.report_limit(&worker))
            })
            .collect::<Vec<_>>();
        let acks = handles
            .into_iter()
            .map(|handle| handle.join().expect("join").expect("ack"))
            .collect::<Vec<_>>();
        wait_for_failover(&coordinator);

        assert_eq!(
            acks.iter().filter(|ack| **ack == LimitAck::Started).count(),
            1
        );
        assert_eq!(ops.world().switches.len(), 1);
    }

    #[test]
    fn no_eligible_account_fails_cleanly_without_touching_credentials() {
        let mut world = world();
        world.quotas.insert("b".into(), quota(0, 50));
        world.accounts[2].invoke_allowed = false;
        world.quotas.insert("c".into(), quota(100, 100));
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 401);

        coordinator.report_limit(&worker).expect("start");
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::NoEligibleAccount)
        );
        assert!(
            ops.world().switches.is_empty(),
            "a disallowed account is never used"
        );
        assert_eq!(ops.world().active.as_deref(), Some("a"));
    }

    #[test]
    fn a_failed_verification_is_reported_and_workers_do_not_resume() {
        let mut world = world();
        world.switch_result = Some(FailoverCode::AccountVerificationFailed);
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 501);

        coordinator.report_limit(&worker).expect("start");
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::AccountVerificationFailed)
        );
        assert_eq!(
            ops.world().switches,
            vec!["c".to_string()],
            "one attempt only"
        );
        assert_eq!(coordinator.end_run(&worker), Ok(RunEnd::Unchanged));
    }

    fn wait_until_waiting(coordinator: &Coordinator) -> SwitchAccounts {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(accounts) = coordinator.waiting_for_codex() {
                return accounts;
            }
            assert!(
                Instant::now() < deadline,
                "failover did not ask to close Codex"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_codex_the_user_opened_pauses_the_failover_until_it_is_closed() {
        let mut world = world();
        world.other_codex = true;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 601);

        coordinator.report_limit(&worker).expect("start");
        let waiting = wait_until_waiting(&coordinator);
        assert_eq!(
            waiting,
            SwitchAccounts {
                from: "a".into(),
                to: "c".into()
            }
        );
        assert!(
            ops.world().switches.is_empty(),
            "nothing switches while Codex is open"
        );
        assert!(coordinator.status().1, "workers keep waiting");

        ops.world().other_codex = false;
        assert_eq!(block_on(coordinator.await_failover(&worker)), Ok(()));
        let world = ops.world();
        assert_eq!(world.switches, vec!["c".to_string()]);
        assert_eq!(
            world.waiting_events,
            vec![
                Some(SwitchAccounts {
                    from: "a".into(),
                    to: "c".into()
                }),
                None
            ]
        );
        assert_eq!(coordinator.waiting_for_codex(), None);
    }

    #[test]
    fn the_user_can_cancel_a_failover_that_waits_for_codex() {
        let mut world = world();
        world.other_codex = true;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 602);

        coordinator.report_limit(&worker).expect("start");
        wait_until_waiting(&coordinator);
        coordinator.cancel_waiting_failover();
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::ExternalCodexRunning)
        );
        assert!(ops.world().switches.is_empty());
        assert_eq!(coordinator.waiting_for_codex(), None);
    }

    #[test]
    fn turning_invoke_mode_off_while_waiting_ends_the_failover() {
        let mut world = world();
        world.other_codex = true;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 603);

        coordinator.report_limit(&worker).expect("start");
        wait_until_waiting(&coordinator);
        ops.world().invoke_mode = false;
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::InvokeModeDisabled)
        );
        assert!(ops.world().switches.is_empty());
    }

    #[test]
    fn the_user_is_not_asked_to_close_codex_when_no_account_can_take_over() {
        let mut world = world();
        world.other_codex = true;
        world.accounts[1].invoke_allowed = false;
        world.accounts[2].invoke_allowed = false;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 604);

        coordinator.report_limit(&worker).expect("start");
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::NoEligibleAccount)
        );
        assert!(ops.world().waiting_events.is_empty());
    }

    #[test]
    fn an_app_server_that_will_not_stop_blocks_the_switch() {
        let mut world = world();
        world.stubborn.insert(701);
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 701);

        coordinator.report_limit(&worker).expect("start");
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::CodexShutdownFailed)
        );
        assert!(ops.world().switches.is_empty());
    }

    #[test]
    fn an_unidentified_live_account_is_reported_without_a_switch() {
        let mut world = world();
        world.active = None;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 1301);
        assert_eq!(
            coordinator.report_limit(&worker),
            Err(FailoverCode::CurrentAccountUnknown)
        );
        assert!(ops.world().switches.is_empty());
        assert!(!coordinator.status().1);
    }

    #[test]
    fn a_refused_switch_that_leaves_the_live_account_unknown_never_resumes() {
        // Found in a real run: a pending switch record makes the live account
        // unidentifiable, which must not read as a completed switch.
        let mut world = world();
        world.switch_result = Some(FailoverCode::AccountSwitchFailed);
        world.unknown_after_refusal = true;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 1401);

        assert_eq!(coordinator.end_run(&worker), Ok(RunEnd::Unchanged));
        coordinator.report_limit(&worker).expect("start");
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::AccountSwitchFailed)
        );
        assert_eq!(
            coordinator.last_failure_detail().as_deref(),
            Some("recovery_required")
        );
        assert_eq!(coordinator.end_run(&worker), Ok(RunEnd::Unchanged));
        assert_eq!(
            coordinator.report_limit(&worker),
            Err(FailoverCode::CurrentAccountUnknown)
        );
    }

    #[test]
    fn manual_mode_refuses_failover() {
        let mut world = world();
        world.invoke_mode = false;
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 801);
        assert_eq!(
            coordinator.report_limit(&worker),
            Err(FailoverCode::InvokeModeDisabled)
        );
        assert!(ops.world().switches.is_empty());
        assert!(!coordinator.status().1);
    }

    #[test]
    fn new_runs_wait_for_a_running_failover_and_then_start_on_the_new_account() {
        let (coordinator, ops) = setup(world());
        let worker = running_worker(&coordinator, &ops, 1, 901);
        let waiting = coordinator.open_lease(2, request("model-b", "medium"));

        coordinator.report_limit(&worker).expect("start");
        block_on(coordinator.begin_run(&waiting)).expect("begin after failover");
        assert!(!coordinator.status().1);
        assert_eq!(ops.world().active.as_deref(), Some("c"));
        assert_eq!(coordinator.end_run(&waiting), Ok(RunEnd::Unchanged));
    }

    #[test]
    fn an_app_server_registered_during_a_failover_is_stopped_at_once() {
        let mut world = world();
        world.stubborn.insert(1001);
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 1001);
        let late = coordinator.open_lease(2, request("model-a", "high"));
        block_on(coordinator.begin_run(&late)).expect("begin");

        coordinator.report_limit(&worker).expect("start");
        coordinator
            .record_app_server(&late, 1002)
            .expect("register");
        assert!(ops.world().terminated.contains(&1002));
        wait_for_failover(&coordinator);
    }

    #[test]
    fn a_closed_connection_forgets_its_worker_and_stops_its_app_server() {
        let (coordinator, ops) = setup(world());
        let worker = running_worker(&coordinator, &ops, 7, 1101);
        coordinator.drop_connection(7);
        assert_eq!(coordinator.status(), (0, false));
        assert!(ops.world().terminated.contains(&1101));
        assert_eq!(
            coordinator.end_run(&worker),
            Err(FailoverCode::UnknownLease)
        );
    }

    /// One Codex bucket whose windows have these remaining percentages and
    /// reset times.
    fn quota_resetting(windows: &[(u8, Option<i64>)]) -> QuotaSnapshot {
        let mut snapshot = quota(50, 50);
        snapshot.buckets[0].windows = windows
            .iter()
            .map(|(remaining, resets_at)| QuotaWindow {
                kind: QuotaWindowKind::FiveHour,
                used_percent: Some(100 - remaining),
                remaining_percent: Some(*remaining),
                window_duration_mins: None,
                resets_at: *resets_at,
            })
            .collect();
        snapshot
    }

    /// A, B, and C have all run out; A can use Codex again first, at 5000.
    fn depleted_world() -> World {
        World {
            now: 1000,
            quotas: HashMap::from([
                (
                    "a".into(),
                    quota_resetting(&[(0, Some(5000)), (40, Some(9900))]),
                ),
                (
                    "b".into(),
                    quota_resetting(&[(30, Some(2000)), (0, Some(9000))]),
                ),
                (
                    "c".into(),
                    quota_resetting(&[(0, Some(3000)), (0, Some(7000))]),
                ),
            ]),
            ..world()
        }
    }

    #[test]
    fn running_out_everywhere_pauses_invoke_mode_until_the_first_reset() {
        let (coordinator, ops) = setup(depleted_world());
        let worker = running_worker(&coordinator, &ops, 1, 301);
        assert_eq!(coordinator.report_limit(&worker), Ok(LimitAck::Started));
        assert_eq!(
            block_on(coordinator.await_failover(&worker)),
            Err(FailoverCode::NoEligibleAccount)
        );
        assert!(ops.world().switches.is_empty());
        assert_eq!(ops.world().terminated, vec![301]);
        let pause = InvokePause {
            resumes_at: Some(5000),
        };
        assert_eq!(coordinator.pause(), Some(pause.clone()));
        assert_eq!(ops.world().pause_events, vec![Some(pause)]);

        // Nothing starts Codex while paused, including a resumed thread.
        assert_eq!(
            block_on(coordinator.begin_run(&worker)),
            Err(FailoverCode::InvokePaused)
        );
        let other = coordinator.open_lease(2, request("model-a", "high"));
        assert_eq!(
            block_on(coordinator.begin_run(&other)),
            Err(FailoverCode::InvokePaused)
        );

        ops.world().now = 5000;
        assert_eq!(coordinator.pause(), None);
        assert_eq!(block_on(coordinator.begin_run(&other)), Ok(()));
    }

    #[test]
    fn a_pause_without_a_known_reset_lasts_until_the_user_resumes() {
        let mut world = depleted_world();
        for quota in world.quotas.values_mut() {
            for window in &mut quota.buckets[0].windows {
                window.resets_at = None;
            }
        }
        let (coordinator, ops) = setup(world);
        let worker = running_worker(&coordinator, &ops, 1, 401);
        coordinator.report_limit(&worker).expect("limit");
        wait_for_failover(&coordinator);
        ops.world().now = i64::MAX;
        assert_eq!(coordinator.pause(), Some(InvokePause { resumes_at: None }));

        coordinator.resume();
        assert_eq!(coordinator.pause(), None);
        assert_eq!(block_on(coordinator.begin_run(&worker)), Ok(()));
        assert_eq!(
            ops.world().pause_events,
            vec![Some(InvokePause { resumes_at: None }), None]
        );
        // Resuming when nothing is paused reports nothing.
        coordinator.resume();
        assert_eq!(ops.world().pause_events.len(), 2);
    }

    #[test]
    fn a_switch_that_fails_for_another_reason_does_not_pause() {
        let (coordinator, ops) = setup(World {
            switch_result: Some(FailoverCode::AccountSwitchFailed),
            ..world()
        });
        let worker = running_worker(&coordinator, &ops, 1, 501);
        coordinator.report_limit(&worker).expect("limit");
        wait_for_failover(&coordinator);
        assert_eq!(coordinator.pause(), None);
        assert!(ops.world().pause_events.is_empty());
    }

    #[test]
    fn the_reset_time_is_when_the_first_account_has_no_spent_window() {
        // An account is usable again once its last spent window resets.
        assert_eq!(
            account_reset(&quota_resetting(&[
                (0, Some(300)),
                (0, Some(700)),
                (20, Some(100))
            ])),
            Some(700)
        );
        // A reported limit with no window at zero waits for every window.
        let mut reached = quota_resetting(&[(10, Some(400)), (30, Some(800))]);
        reached.buckets[0].rate_limit_reached_type = Some("rate_limit_reached".into());
        assert_eq!(account_reset(&reached), Some(800));
        // Unknown when a spent window has no reset time or none is spent.
        assert_eq!(
            account_reset(&quota_resetting(&[(0, None), (0, Some(900))])),
            None
        );
        assert_eq!(account_reset(&quota_resetting(&[(50, Some(900))])), None);

        assert_eq!(
            earliest_reset(&[
                Some(quota_resetting(&[(0, Some(900))])),
                None,
                Some(quota_resetting(&[(0, None)])),
                Some(quota_resetting(&[(0, Some(600))])),
            ]),
            Some(600)
        );
        assert_eq!(earliest_reset(&[None]), None);
    }
}
