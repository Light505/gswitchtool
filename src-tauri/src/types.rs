use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexCliInfo {
    pub version: Option<String>,
    pub supports_update: bool,
    pub latest_version: Option<String>,
    pub update_status: CodexCliUpdateStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexCliUpdateStatus {
    Available,
    Current,
    Unknown,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexCliUpdateFailure {
    NotInstalled,
    Unsupported,
    Busy,
    CodexOpen,
    UpdateFailed,
    VerificationFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    ChatGpt,
    ApiKey,
}

/// A non-secret identifier used only to decide whether two saved profiles are
/// the same Codex account. The complete credential document stays Rust-owned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AccountIdentity {
    ChatGpt {
        user_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
    },
    ApiKey {
        fingerprint: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StoredAccount {
    pub id: String,
    pub label: String,
    pub kind: AccountKind,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_structure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<AccountIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaSnapshot>,
    /// Reset-credit identifiers are credential-adjacent provider secrets. They
    /// are hydrated only inside Rust from the protected vault.
    #[serde(default, skip_serializing)]
    pub reset_credits: Option<StoredResetCredits>,
    /// Opaque key for the encrypted credential material. It is not a secret
    /// and allows metadata to retain logical account ownership across token
    /// rotation.
    #[serde(default)]
    pub credential_ref: String,
    #[serde(default)]
    pub credential_generation: u64,
    /// A replacement saved by sign-in/import/managed refresh has not yet been
    /// installed into live Codex. Never reconcile an older live file over it.
    #[serde(default)]
    pub needs_apply: bool,
    #[serde(default)]
    pub sign_in_required: bool,
    /// The human allowed Invoke Mode to switch Codex to this account
    /// automatically. Absent in older stores, so it defaults to not allowed.
    #[serde(default)]
    pub invoke_allowed: bool,
    /// Kept in Rust memory for existing domain operations, but never written
    /// back into accounts.json. Legacy stores deserialize it only long enough
    /// for the one-time protected-vault migration.
    #[serde(default, skip_serializing)]
    pub credential: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountView {
    pub id: String,
    pub label: String,
    pub kind: AccountKind,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub active: bool,
    pub needs_apply: bool,
    pub sign_in_required: bool,
    pub revision: u64,
    #[serde(default)]
    pub invoke_allowed: bool,
}

/// One Codex model the human allows Claude to invoke, with the reasoning
/// efforts allowed for that model. Efforts differ per model, so the whitelist
/// is a list of model/effort combinations rather than two independent lists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvocationProfile {
    pub model: String,
    pub reasoning_efforts: Vec<String>,
}

/// A suggested model and effort for one kind of delegated task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InvocationDefault {
    pub model: String,
    pub effort: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeSetupKind {
    ClaudeOnly,
    ClaudeCodex,
    Router,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeRouterMode {
    Mixed,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeOnlyReview {
    On,
    Off,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeRouterPrefer {
    #[default]
    Codex,
    Claude,
    Price,
}

fn deserialize_router_prefer<'de, D>(deserializer: D) -> Result<ClaudeRouterPrefer, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some("claude") => ClaudeRouterPrefer::Claude,
        Some("price") => ClaudeRouterPrefer::Price,
        _ => ClaudeRouterPrefer::Codex,
    })
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeRouterSampling {
    #[default]
    On,
    Off,
}

fn deserialize_router_sampling<'de, D>(deserializer: D) -> Result<ClaudeRouterSampling, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some("off") => ClaudeRouterSampling::Off,
        _ => ClaudeRouterSampling::On,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Fixed fields reject unknown models and preserve worker order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaudeAllowed {
    pub haiku: Vec<ClaudeEffort>,
    pub sonnet: Vec<ClaudeEffort>,
    pub opus: Vec<ClaudeEffort>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeRouterOptions {
    pub mode: ClaudeRouterMode,
    #[serde(default, deserialize_with = "deserialize_router_prefer")]
    pub prefer: ClaudeRouterPrefer,
    #[serde(default, deserialize_with = "deserialize_router_sampling")]
    pub sampling: ClaudeRouterSampling,
    pub claude_allowed: ClaudeAllowed,
    pub claude_only_review: ClaudeOnlyReview,
}

impl Default for ClaudeRouterOptions {
    fn default() -> Self {
        use ClaudeEffort::{High, Low, Max, Medium, Xhigh};
        Self {
            mode: ClaudeRouterMode::Mixed,
            prefer: ClaudeRouterPrefer::Codex,
            sampling: ClaudeRouterSampling::On,
            claude_allowed: ClaudeAllowed {
                haiku: vec![Low, Medium],
                sonnet: vec![Low, Medium, High, Xhigh, Max],
                opus: vec![Low, Medium, High, Xhigh, Max],
            },
            claude_only_review: ClaudeOnlyReview::On,
        }
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexSpeedMode {
    #[default]
    Normal,
    Fast,
    Orchestrator,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", from = "Value")]
pub struct CodexSpeed {
    pub mode: CodexSpeedMode,
    pub fast_min_remaining: u8,
}

impl Default for CodexSpeed {
    fn default() -> Self {
        Self {
            mode: CodexSpeedMode::Normal,
            fast_min_remaining: 20,
        }
    }
}

impl From<Value> for CodexSpeed {
    fn from(value: Value) -> Self {
        Self {
            mode: match value.get("mode").and_then(Value::as_str) {
                Some("fast") => CodexSpeedMode::Fast,
                Some("orchestrator") => CodexSpeedMode::Orchestrator,
                _ => CodexSpeedMode::Normal,
            },
            fast_min_remaining: value
                .get("fastMinRemaining")
                .and_then(Value::as_f64)
                .filter(|cutoff| cutoff.fract() == 0.0 && (0.0..=90.0).contains(cutoff))
                .map(|cutoff| cutoff as u8)
                .unwrap_or(20),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaudeSetup {
    pub setup: ClaudeSetupKind,
    pub router: ClaudeRouterOptions,
    #[serde(default, rename = "codexSpeed")]
    pub codex_speed: CodexSpeed,
    #[serde(
        default = "default_session_limit",
        deserialize_with = "lenient_session_limit",
        rename = "sessionLimit"
    )]
    pub session_limit: u32,
}

pub const DEFAULT_SESSION_LIMIT: u32 = 250_000;

fn default_session_limit() -> u32 {
    DEFAULT_SESSION_LIMIT
}

fn lenient_session_limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (100_000.0..=1_000_000.0).contains(n))
        .map(|n| n as u32)
        .unwrap_or(DEFAULT_SESSION_LIMIT))
}

impl ClaudeSetup {
    pub fn from_invoke_mode(enabled: bool) -> Self {
        Self {
            setup: if enabled {
                ClaudeSetupKind::ClaudeCodex
            } else {
                ClaudeSetupKind::ClaudeOnly
            },
            router: ClaudeRouterOptions::default(),
            codex_speed: CodexSpeed::default(),
            session_limit: DEFAULT_SESSION_LIMIT,
        }
    }

    pub fn invoke_mode(&self) -> bool {
        match self.setup {
            ClaudeSetupKind::ClaudeOnly => false,
            ClaudeSetupKind::ClaudeCodex => true,
            ClaudeSetupKind::Router => {
                self.router.mode != ClaudeRouterMode::Claude
                    || self.router.claude_only_review == ClaudeOnlyReview::On
            }
        }
    }

    pub fn normalize(&mut self) {
        for efforts in [
            &mut self.router.claude_allowed.haiku,
            &mut self.router.claude_allowed.sonnet,
            &mut self.router.claude_allowed.opus,
        ] {
            efforts.sort();
            efforts.dedup();
        }
    }
}

impl Default for ClaudeSetup {
    fn default() -> Self {
        Self::from_invoke_mode(false)
    }
}

/// Human-owned Invoke Mode policy. Only the WebView commands change it; the
/// Claude-facing surface can read it but never write it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(from = "InvokeSettingsInput")]
pub struct InvokeSettings {
    #[serde(default)]
    pub invoke_mode: bool,
    #[serde(default)]
    pub claude_setup: ClaudeSetup,
    #[serde(default)]
    pub allowed_invocation_profiles: Vec<InvocationProfile>,
    /// Optional suggestions for Claude; request validation does not enforce them.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub task_defaults: std::collections::BTreeMap<String, InvocationDefault>,
    /// Saved-account IDs, most preferred first. Accounts not listed follow in
    /// saved order.
    #[serde(default)]
    pub account_priority: Vec<String>,
    /// A preferred account is used while it has at least this much of every
    /// Codex usage window left, in percent.
    #[serde(default = "default_preferred_min_remaining")]
    pub preferred_min_remaining: u8,
    /// How many delegated Codex tasks may run at once; more wait their turn.
    #[serde(default = "default_max_concurrent_tasks")]
    pub max_concurrent_tasks: u8,
    /// Wake allowed accounts whose usage window has not started.
    #[serde(default)]
    pub auto_wake: bool,
    /// Saved-account ID to the percent of its weekly window that automatic
    /// choices leave unused.
    #[serde(default)]
    pub weekly_reserve: std::collections::BTreeMap<String, u8>,
}

// Missing setup is migrated from the old Invoke Mode flag at deserialization.
#[derive(Deserialize)]
struct InvokeSettingsInput {
    #[serde(default)]
    invoke_mode: bool,
    #[serde(default)]
    claude_setup: Option<ClaudeSetup>,
    #[serde(default)]
    allowed_invocation_profiles: Vec<InvocationProfile>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    task_defaults: std::collections::BTreeMap<String, InvocationDefault>,
    #[serde(default)]
    account_priority: Vec<String>,
    #[serde(default = "default_preferred_min_remaining")]
    preferred_min_remaining: u8,
    #[serde(default = "default_max_concurrent_tasks")]
    max_concurrent_tasks: u8,
    #[serde(default)]
    auto_wake: bool,
    #[serde(default)]
    weekly_reserve: std::collections::BTreeMap<String, u8>,
}

impl From<InvokeSettingsInput> for InvokeSettings {
    fn from(input: InvokeSettingsInput) -> Self {
        let mut claude_setup = input
            .claude_setup
            .unwrap_or_else(|| ClaudeSetup::from_invoke_mode(input.invoke_mode));
        claude_setup.normalize();
        Self {
            invoke_mode: claude_setup.invoke_mode(),
            claude_setup,
            allowed_invocation_profiles: input.allowed_invocation_profiles,
            task_defaults: input.task_defaults,
            account_priority: input.account_priority,
            preferred_min_remaining: input.preferred_min_remaining,
            max_concurrent_tasks: input.max_concurrent_tasks,
            auto_wake: input.auto_wake,
            weekly_reserve: input.weekly_reserve,
        }
    }
}

pub const DEFAULT_PREFERRED_MIN_REMAINING: u8 = 20;
pub const DEFAULT_MAX_CONCURRENT_TASKS: u8 = 2;
pub const MAX_CONCURRENT_TASKS_LIMIT: u8 = 6;

fn default_preferred_min_remaining() -> u8 {
    DEFAULT_PREFERRED_MIN_REMAINING
}

fn default_max_concurrent_tasks() -> u8 {
    DEFAULT_MAX_CONCURRENT_TASKS
}

impl Default for InvokeSettings {
    fn default() -> Self {
        Self {
            invoke_mode: false,
            claude_setup: ClaudeSetup::default(),
            allowed_invocation_profiles: Vec::new(),
            task_defaults: std::collections::BTreeMap::new(),
            account_priority: Vec::new(),
            preferred_min_remaining: DEFAULT_PREFERRED_MIN_REMAINING,
            max_concurrent_tasks: DEFAULT_MAX_CONCURRENT_TASKS,
            auto_wake: false,
            weekly_reserve: std::collections::BTreeMap::new(),
        }
    }
}

/// A model reported by the installed Codex App Server's `model/list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogModel {
    pub model: String,
    pub display_name: String,
    pub supported_reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub service_tiers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    pub is_default: bool,
    /// The saved accounts that can use the model, when some cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_on: Option<Vec<String>>,
}

/// A display-only outcome for one bounded user-selected account-file batch.
/// Parsed credentials and failure details stay in Rust; the WebView receives
/// only saved profiles and aggregate counts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportResult {
    #[serde(default)]
    pub imported: Vec<AccountView>,
    pub duplicate_count: u32,
    pub unsupported_count: u32,
    pub failed_count: u32,
}

/// Aggregate outcome of an explicit portable account export. The selected
/// credential documents and destination path stay Rust-owned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExportResult {
    pub exported_count: u32,
    pub cancelled: bool,
}

/// A source adapter exposed by the one-shot local migration assistant. The
/// enum is intentionally closed: discovery never becomes a generic plugin or
/// filesystem search surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationSource {
    OfficialCodex,
    CockpitTools,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationCandidateState {
    New,
    AlreadyPresent,
    Unsupported,
}

/// Sanitized preview data for a local migration candidate. Credential
/// documents, raw source records, keys, paths, and provider payloads remain
/// Rust-owned and never cross the Tauri boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationCandidateView {
    pub id: String,
    pub source: MigrationSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub state: MigrationCandidateState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationPreview {
    #[serde(default)]
    pub candidates: Vec<MigrationCandidateView>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingSwitch {
    pub target_id: String,
    pub target_identity: AccountIdentity,
    pub previous_active_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub secret_generation: u64,
    #[serde(default, skip_serializing)]
    pub previous_auth: Option<Value>,
    pub stage: PendingSwitchStage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingSwitchStage {
    Prepared,
    Verified,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStoreMode {
    File,
    Keyring,
    Auto,
    Ephemeral,
    Unknown,
}

/// The running app's version, and whether it is the dev build.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppVersion {
    pub version: String,
    pub dev: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeInfo {
    pub codex_home: String,
    pub auth_file_exists: bool,
    pub credential_store: CredentialStoreMode,
}

/// The health of GSwitch-owned account storage. This deliberately says
/// nothing about the live Codex credential file: a damaged GSwitch library
/// must never be mistaken for a damaged Codex installation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageStatus {
    Ready,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageView {
    pub status: StorageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A single read-only view for the initial workspace render. Credential
/// documents and raw storage errors remain on the Rust side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSnapshot {
    pub storage: StorageView,
    #[serde(default)]
    pub accounts: Vec<AccountView>,
    /// Names the saved account of a reset that needs recovery. The provider
    /// credit and idempotency key must remain in Rust-owned storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_reset: Option<PendingResetView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveAccountView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiveAccountStatus {
    Ready,
    NotSignedIn,
    UnknownAccount,
    FileStoreRequired,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveAccountView {
    pub status: LiveAccountStatus,
    pub credential_store: CredentialStoreMode,
    pub account: Option<AccountView>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SwitchOutcome {
    pub account: AccountView,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SwitchFailureCode {
    OperationBusy,
    CodexOpen,
    AccountNeedsSignIn,
    FileStoreRequired,
    CredentialsChanged,
    RecoveryRequired,
    LocalVerificationFailed,
    CodexAppServerUnavailable,
    CodexConfigUnavailable,
    CodexConfigCleanupFailed,
    CurrentCredentialUnreadable,
    CurrentAccountNotSaved,
    TargetCheckUnavailable,
    TargetWorkspaceMismatch,
    PostWriteVerificationFailed,
    VerificationFailed,
}

/// A deliberately small, sanitized command error. Detailed provider,
/// filesystem, and recovery errors stay inside Rust.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SwitchFailure {
    pub code: SwitchFailureCode,
}

impl SwitchFailure {
    pub fn new(code: SwitchFailureCode) -> Self {
        Self { code }
    }
}

/// A provider-reported capacity snapshot. It is operational state, not usage
/// analytics: credentials and raw App Server payloads stay in Rust.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuotaSnapshot {
    pub fetched_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinary_usage_allowed: Option<bool>,
    #[serde(default)]
    pub buckets: Vec<QuotaBucket>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<ResetCreditsView>,
}

/// A display-only reset-credit summary. It intentionally excludes opaque
/// provider credit IDs; Rust reselects the eligible credit immediately before
/// a user-confirmed redemption.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResetCreditsView {
    pub available_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearest_expiry: Option<i64>,
    pub details_available: bool,
    pub can_redeem: bool,
    #[serde(default)]
    pub usable_credits: Vec<ResetCreditDetailView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResetCreditDetailView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// With `expires_at`, identifies the credit a user picks without exposing
    /// the provider's credit ID to the WebView.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<i64>,
    /// The provider's display title for the credit, such as "Full reset".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Rust-owned reset-credit data. The opaque ID is never part of a Tauri
/// command response or WebView state.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredResetCredits {
    pub available_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<Vec<StoredResetCredit>>,
    /// When the credit list was last read from the usage endpoint's detail
    /// lookup; absent when it came from elsewhere or is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details_read_at_unix_ms: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredResetCredit {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// The provider's reset kind. Absent in older payloads, which carried only
    /// Codex rate-limit resets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingResetCredit {
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub secret_generation: u64,
    #[serde(default, skip_serializing)]
    pub credit_id: String,
    #[serde(default, skip_serializing)]
    pub idempotency_key: String,
    pub created_at_unix_ms: i64,
    /// Set only after the provider rejected a replay of a credit it no longer
    /// lists as available, so retrying can never consume it.
    #[serde(default)]
    pub discard_allowed: bool,
}

/// A reset that needs recovery, as the WebView sees it: the saved account it
/// belongs to and whether retrying can no longer help. The provider credit and
/// idempotency key stay in Rust-owned storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingResetView {
    pub account_id: String,
    pub discardable: bool,
}

/// Complete account material kept exclusively in the encrypted vault. The
/// metadata store intentionally owns neither a credential document nor reset
/// credit identifiers.
#[derive(Clone, Serialize, Deserialize)]
pub struct AccountSecret {
    pub credential: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<StoredResetCredits>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingSwitchSecret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_auth: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingResetCreditSecret {
    pub credit_id: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetCreditOutcomeKind {
    Reset,
    AlreadyRedeemed,
    NothingToReset,
    NoCredit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResetCreditOutcome {
    pub account_id: String,
    pub outcome: ResetCreditOutcomeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_warning: Option<String>,
    /// Expiry of the credit this request used, when the provider listed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_expires_at: Option<i64>,
}

/// Why a reset did not produce a result. Only a stable code crosses the
/// Rust/WebView boundary, and each code says whether a credit could have been
/// used: before the consume request nothing was spent; `provider_rejected` and
/// `result_unknown` keep a pending record so a retry reuses the same credit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetCreditFailureCode {
    OperationBusy,
    CodexOpen,
    RecoveryRequired,
    DetailsUnavailable,
    CreditsChanged,
    NotStarted,
    ProviderRejected,
    ResultUnknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResetCreditFailure {
    pub code: ResetCreditFailureCode,
}

/// A short-lived, in-memory Wake result. Wake is intentionally not a job
/// system: completed operations may disappear when the app restarts or when a
/// later operation replaces them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WakeResultKind {
    ReplyReceived,
    RateLimited,
    NeedsSignIn,
    SentNotConfirmed,
    ModelUnavailable,
    InvalidRequest,
    ServiceUnavailable,
    RequestRejected,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WakeRequestState {
    NotSent,
    MayHaveSent,
    Sent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeAccountResult {
    pub account_id: String,
    pub label: String,
    pub result: WakeResultKind,
    pub request_state: WakeRequestState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default, skip_serializing)]
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WakeOperationStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeOperationView {
    pub id: String,
    pub status: WakeOperationStatus,
    #[serde(default)]
    pub alternate_model: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_account_id: Option<String>,
    #[serde(default)]
    pub results: Vec<WakeAccountResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeStart {
    pub operation_id: String,
}

/// How a signed update is delivered on this particular installed package.
/// This is intentionally independent from Codex account state: it only tells
/// the WebView whether Tauri can install and whether a relaunch is required.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpdateDelivery {
    InstallerExits,
    RelaunchRequired,
    ReleaseDownload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuotaBucket {
    pub limit_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_reached_type: Option<String>,
    pub kind: QuotaBucketKind,
    #[serde(default)]
    pub windows: Vec<QuotaWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaBucketKind {
    Codex,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuotaWindow {
    pub kind: QuotaWindowKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_duration_mins: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaWindowKind {
    FiveHour,
    Weekly,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaStatus {
    Fresh,
    Stale,
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuotaView {
    pub account_id: String,
    pub status: QuotaStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<QuotaSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaRefreshFailureCode {
    OperationBusy,
    CodexAccountUnknown,
    Authentication,
    ManualRefreshNeeded,
    RateLimited,
    Network,
    Service,
    InvalidResponse,
    IdentityMismatch,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuotaRefreshFailure {
    pub code: QuotaRefreshFailureCode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OAuthLoginStart {
    pub login_id: String,
    pub auth_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OAuthLoginStatus {
    Pending,
    Finishing,
    Complete {
        account: AccountView,
        cleanup_warning: bool,
    },
    Cancelled,
    Failed {
        code: OAuthFailureCode,
        retryable: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OAuthFailureCode {
    NotCompleted,
    TimedOut,
    IdentityMismatch,
    Authentication,
    Network,
    LocalCodex,
    VerificationFailed,
    SaveFailed,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_snapshot_names_only_the_account_of_a_pending_reset() {
        let snapshot = AppSnapshot {
            storage: StorageView {
                status: StorageStatus::Ready,
                message: None,
            },
            accounts: Vec::new(),
            pending_reset: Some(PendingResetView {
                account_id: "account-1".into(),
                discardable: false,
            }),
            runtime: None,
            live: None,
        };

        let serialized = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(serialized
            .contains("\"pending_reset\":{\"account_id\":\"account-1\",\"discardable\":false}"));
        assert!(!serialized.contains("credit_id"));
        assert!(!serialized.contains("idempotency_key"));
    }
}
