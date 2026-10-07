export type AccountKind = "chat_gpt" | "api_key";

export interface AccountView {
  id: string;
  label: string;
  kind: AccountKind;
  email?: string;
  plan_type?: string;
  workspace_name?: string;
  active: boolean;
  needs_apply?: boolean;
  sign_in_required?: boolean;
  revision?: number;
  invoke_allowed?: boolean;
}

export interface InvocationProfile {
  model: string;
  reasoning_efforts: string[];
}

export type InvokeTaskKind = "review" | "research" | "mechanical" | "complex";

export interface InvocationDefault {
  model: string;
  effort: string;
}

export interface InvokeSettings {
  invoke_mode: boolean;
  allowed_invocation_profiles: InvocationProfile[];
  task_defaults?: Partial<Record<InvokeTaskKind, InvocationDefault>>;
  /** Saved-account IDs, most preferred first. */
  account_priority?: string[];
  /** Percent of each usage window a preferred account must have left. */
  preferred_min_remaining?: number;
  max_concurrent_tasks?: number;
  /** Wake allowed accounts whose usage window has not started. */
  auto_wake?: boolean;
  /** Saved-account ID to the percent of its week automatic choices leave. */
  weekly_reserve?: Record<string, number>;
}

/** A Codex task Claude delegated, running or waiting its turn. */
export interface InvokeTask {
  id: string;
  started_at: number;
  model: string;
  reasoning_effort: string;
  write: boolean;
  cwd: string;
  thread_id?: string | null;
  running: boolean;
  /** The user stopped it; it disappears once its worker has ended. */
  stopping?: boolean;
}

/** One step of a Codex task, read from Codex's own session log. */
export type LogItem =
  | { kind: "task"; text: string }
  | { kind: "message"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "command"; text: string }
  | { kind: "patch"; files: string[] }
  | { kind: "output"; text: string }
  | { kind: "done"; seconds?: number | null }
  | { kind: "stopped" }
  | ({ kind: "tokens"; total: number } & TokenUsage);

export interface LogChunk {
  found: boolean;
  items: LogItem[];
  offset: number;
}

export interface PausedThread {
  thread_id: string;
  model: string;
  reasoning_effort: string;
  cwd: string;
}

/** One entry of the Invoke Mode activity history. */
export type ActivityEntry = { at: number } & (
  | { kind: "task_started"; task: string; model: string; effort: string; write: boolean; cwd: string }
  | { kind: "task_ended"; task: string; model: string; thread_id?: string | null; status: string; code?: string | null; usage?: TokenUsage }
  | { kind: "task_stopped"; task: string; model: string; thread_id?: string | null; usage?: TokenUsage }
  | { kind: "switched"; from: string; to: string; reason: "usage_limit" | "priority" | "model" }
  | { kind: "paused"; resumes_at?: number | null; threads: string[] }
  | { kind: "resumed"; by_user: boolean; threads: string[] }
  | { kind: "woke"; accounts: string[] }
);

export interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface SwitchAccounts {
  from: string;
  to: string;
}

/** Invoke Mode starts no Codex work until `resumes_at` (Unix seconds) or the user resumes it. */
export interface InvokePause {
  resumes_at: number | null;
}

export interface CatalogModel {
  model: string;
  display_name: string;
  supported_reasoning_efforts: string[];
  default_reasoning_effort?: string;
  is_default: boolean;
  /** Saved accounts that can use the model, when some cannot. */
  only_on?: string[] | null;
}

export type CredentialStoreMode =
  | "file"
  | "keyring"
  | "auto"
  | "ephemeral"
  | "unknown";

export interface AppVersion {
  version: string;
  dev: boolean;
}

export interface RuntimeInfo {
  codex_home: string;
  auth_file_exists: boolean;
  credential_store: CredentialStoreMode;
}

export interface CodexCliInfo {
  version?: string;
  supports_update: boolean;
  latest_version?: string;
  update_status: "available" | "current" | "unknown" | "missing";
}

export type CodexCliUpdateFailure =
  | "not_installed"
  | "unsupported"
  | "busy"
  | "codex_open"
  | "update_failed"
  | "verification_failed";

export type StorageStatus = "ready" | "recovery_required";

export interface StorageView {
  status: StorageStatus;
  message?: string;
}

// The provider credit and idempotency key of a pending reset stay in Rust.
export interface PendingResetView {
  account_id: string;
  discardable: boolean;
}

export interface AppSnapshot {
  storage: StorageView;
  accounts: AccountView[];
  pending_reset?: PendingResetView;
  runtime?: RuntimeInfo;
  live?: LiveAccountView;
}

export type LiveAccountStatus =
  | "ready"
  | "not_signed_in"
  | "unknown_account"
  | "file_store_required"
  | "recovery_required";

export interface LiveAccountView {
  status: LiveAccountStatus;
  credential_store: CredentialStoreMode;
  account?: AccountView;
  message?: string;
}

export interface SwitchOutcome {
  account: AccountView;
}

export type SwitchFailureCode =
  | "operation_busy"
  | "codex_open"
  | "account_needs_sign_in"
  | "file_store_required"
  | "credentials_changed"
  | "recovery_required"
  | "local_verification_failed"
  | "codex_app_server_unavailable"
  | "codex_config_unavailable"
  | "codex_config_cleanup_failed"
  | "current_credential_unreadable"
  | "current_account_not_saved"
  | "target_check_unavailable"
  | "target_workspace_mismatch"
  | "post_write_verification_failed"
  | "verification_failed";

export interface SwitchFailure {
  code: SwitchFailureCode;
}

export interface OAuthLoginStart {
  login_id: string;
  auth_url: string;
}

export type OAuthLoginStatus =
  | { status: "pending" }
  | { status: "finishing" }
  | { status: "complete"; account: AccountView; cleanup_warning: boolean }
  | { status: "cancelled" }
  | { status: "failed"; code: OAuthFailureCode; retryable: boolean };

export type OAuthFailureCode =
  | "not_completed" | "timed_out" | "identity_mismatch"
  | "authentication" | "network" | "local_codex"
  | "verification_failed" | "save_failed" | "unavailable";

export interface ImportResult {
  imported: AccountView[];
  duplicate_count: number;
  unsupported_count: number;
  failed_count: number;
}

export interface ExportResult {
  exported_count: number;
  cancelled: boolean;
}

export type MigrationSource = "official_codex" | "cockpit_tools";
export type MigrationCandidateState = "new" | "already_present" | "unsupported";

export interface MigrationCandidate {
  id: string;
  source: MigrationSource;
  email?: string;
  workspace_name?: string;
  plan_type?: string;
  state: MigrationCandidateState;
}

export interface MigrationPreview {
  candidates: MigrationCandidate[];
}

export type QuotaStatus = "fresh" | "stale" | "unknown" | "not_applicable";

export type QuotaRefreshFailureCode =
  | "operation_busy" | "codex_account_unknown" | "authentication"
  | "manual_refresh_needed"
  | "rate_limited" | "network" | "service" | "invalid_response"
  | "identity_mismatch" | "unavailable";

export interface QuotaRefreshFailure {
  code: QuotaRefreshFailureCode;
}

export interface QuotaWindow {
  kind: "five_hour" | "weekly" | "other";
  used_percent?: number;
  remaining_percent?: number;
  window_duration_mins?: number;
  resets_at?: number;
}

export interface QuotaBucket {
  limit_id: string;
  limit_name?: string;
  plan_type?: string;
  rate_limit_reached_type?: string;
  kind: "codex" | "other";
  windows: QuotaWindow[];
}

export interface ResetCreditDetail {
  expires_at?: number;
  granted_at?: number;
  // The provider's display title, such as "Full reset (Weekly + 5 hr)".
  title?: string;
}

export interface ResetCreditsView {
  available_count: number;
  nearest_expiry?: number;
  details_available: boolean;
  can_redeem: boolean;
  // Provider credit IDs deliberately never cross the Rust/WebView boundary.
  usable_credits: ResetCreditDetail[];
}

export interface QuotaView {
  account_id: string;
  status: QuotaStatus;
  snapshot?: {
    fetched_at_unix_ms: number;
    account_id?: string;
    ordinary_usage_allowed?: boolean;
    buckets: QuotaBucket[];
    reset_credits?: ResetCreditsView;
  };
  message?: string;
}

export type ResetCreditOutcomeKind =
  | "reset"
  | "already_redeemed"
  | "nothing_to_reset"
  | "no_credit";

export interface ResetCreditOutcome {
  account_id: string;
  outcome: ResetCreditOutcomeKind;
  quota?: QuotaView;
  refresh_warning?: string;
  used_expires_at?: number;
}

export type ResetCreditFailureCode =
  | "operation_busy"
  | "codex_open"
  | "recovery_required"
  | "details_unavailable"
  | "credits_changed"
  | "not_started"
  | "provider_rejected"
  | "result_unknown";

export interface ResetCreditFailure {
  code: ResetCreditFailureCode;
}

export type WakeResultKind =
  | "reply_received"
  | "rate_limited"
  | "needs_sign_in"
  | "sent_not_confirmed"
  | "model_unavailable"
  | "invalid_request"
  | "service_unavailable"
  | "request_rejected"
  | "failed"
  | "cancelled";

export interface WakeAccountResult {
  account_id: string;
  label: string;
  result: WakeResultKind;
  request_state: "not_sent" | "may_have_sent" | "sent";
  http_status?: number;
}

export interface WakeOperationView {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
  alternate_model?: boolean;
  current_account_id?: string;
  results: WakeAccountResult[];
}

export interface WakeStart {
  operation_id: string;
}
