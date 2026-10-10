import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccountView,
  AppSnapshot,
  CatalogModel,
  CodexCliInfo,
  ExportResult,
  ImportResult,
  InvocationProfile,
  InvocationDefault,
  InvokeTaskKind,
  InvokeSettings,
  ClaudeSetup,
  InvokePause,
  SwitchAccounts,
  LiveAccountView,
  MigrationPreview,
  OAuthLoginStart,
  OAuthLoginStatus,
  QuotaView,
  ResetCreditDetail,
  ResetCreditOutcome,
  RuntimeInfo,
  AppVersion,
  ActivityEntry,
  InvokeTask,
  LogChunk,
  PausedThread,
  ResultsSummary,
  SwitchOutcome,
  WakeOperationView,
  WakeStart,
} from "./types";

export type UpdateDelivery = "installer_exits" | "relaunch_required" | "release_download";

// Keep provider payloads on the Rust side. The WebView only deals with this
// small, display-oriented capacity view.
/** An account switch Invoke Mode made: after a usage limit, or to a preferred account. */
export interface InvokeSwitch {
  from: string;
  to: string;
  reason?: "usage_limit" | "priority" | "model";
}

export const api = {
  runtimeInfo: () => invoke<RuntimeInfo>("get_runtime_info"),
  appVersion: () => invoke<AppVersion>("get_app_version"),
  codexCliInfo: () => invoke<CodexCliInfo>("get_codex_cli_info"),
  updateCodexCli: () => invoke<CodexCliInfo>("update_codex_cli"),
  openCodexCliGuide: () => invoke<void>("open_codex_cli_guide"),
  appSnapshot: () => invoke<AppSnapshot>("get_app_snapshot"),
  listAccounts: () => invoke<AccountView[]>("list_accounts"),
  resetDamagedAccountStore: () =>
    invoke<void>("reset_damaged_account_store"),
  liveAccount: () => invoke<LiveAccountView>("get_live_account_state"),
  startOAuth: (targetId?: string) => invoke<OAuthLoginStart>("start_oauth_login", { targetId }),
  retryOAuth: (loginId: string) => invoke<void>("retry_oauth_login", { loginId }),
  oauthStatus: (loginId: string) =>
    invoke<OAuthLoginStatus>("get_oauth_login_status", { loginId }),
  cancelOAuth: (loginId: string) =>
    invoke<void>("cancel_oauth_login", { loginId }),
  openOAuth: (loginId: string) =>
    invoke<void>("open_oauth_login", { loginId }),
  importAuthJson: (rawJson: string, label?: string) =>
    invoke<AccountView>("import_auth_json", { rawJson, label }),
  importAuthFile: (path: string) =>
    invoke<ImportResult>("import_auth_file", { path }),
  importAuthFiles: (paths: string[]) =>
    invoke<ImportResult>("import_auth_files", { paths }),
  exportAccounts: (selectedIds: string[]) =>
    invoke<ExportResult>("export_accounts", { selectedIds }),
  discoverLocalAccounts: (customRoot?: string) =>
    invoke<MigrationPreview>("discover_local_accounts", { customRoot }),
  importLocalAccounts: (customRoot: string | undefined, selectedIds: string[]) =>
    invoke<ImportResult>("import_local_accounts", {
      customRoot,
      selectedIds,
    }),
  importApiKey: (apiKey: string, label?: string) =>
    invoke<AccountView>("import_api_key", { apiKey, label }),
  saveCurrentAccount: () => invoke<AccountView>("save_current_account"),
  enableAccountSwitching: () =>
    invoke<boolean>("enable_account_switching"),
  switchAccount: (targetId: string) =>
    invoke<SwitchOutcome>("switch_account", { targetId }),
  recoverPendingSwitch: () => invoke<void>("recover_pending_switch"),
  removeSavedAccount: (id: string) =>
    invoke<void>("remove_saved_account", { id }),
  accountQuota: (id: string) => invoke<QuotaView>("get_account_quota", { id }),
  refreshAccountQuota: (id: string, background = false) =>
    invoke<QuotaView>("refresh_account_quota", { id, background }),
  // Only the credit's non-secret timestamps identify the pick; Rust matches
  // them against a fresh provider read before consuming anything.
  redeemResetCredit: (id: string, credit: ResetCreditDetail) =>
    invoke<ResetCreditOutcome>("redeem_reset_credit", {
      id,
      expiresAt: credit.expires_at ?? null,
      grantedAt: credit.granted_at ?? null,
    }),
  recoverPendingResetCredit: () =>
    invoke<ResetCreditOutcome>("recover_pending_reset_credit"),
  discardPendingResetCredit: () =>
    invoke<void>("discard_pending_reset_credit"),
  startWake: (id: string, alternateModel = false) =>
    invoke<WakeStart>("start_wake", { id, alternateModel }),
  startWakeAll: () => invoke<WakeStart>("start_wake_all"),
  startWakeSelected: (selectedIds: string[]) =>
    invoke<WakeStart>("start_wake_selected", { selectedIds }),
  wakeOperation: (operationId: string) =>
    invoke<WakeOperationView>("get_wake_operation", { operationId }),
  cancelWake: (operationId: string) =>
    invoke<void>("cancel_wake", { operationId }),
  invokeSettings: () => invoke<InvokeSettings>("get_invoke_settings"),
  setClaudeSetup: (setup: ClaudeSetup) =>
    invoke<InvokeSettings>("set_claude_setup", { setup }),
  modelCatalog: (refresh = false) =>
    invoke<CatalogModel[]>("get_model_catalog", { refresh }),
  setInvokeProfiles: (profiles: InvocationProfile[]) =>
    invoke<InvokeSettings>("set_invoke_profiles", { profiles }),
  setInvokePreferences: (accountPriority: string[], preferredMinRemaining: number, maxConcurrentTasks: number, autoWake: boolean) =>
    invoke<InvokeSettings>("set_invoke_preferences", { accountPriority, preferredMinRemaining, maxConcurrentTasks, autoWake }),
  setInvokeWeeklyReserve: (reserve: Record<string, number>) =>
    invoke<InvokeSettings>("set_invoke_weekly_reserve", { reserve }),
  setInvokeTaskDefaults: (taskDefaults: Partial<Record<InvokeTaskKind, InvocationDefault>>) =>
    invoke<InvokeSettings>("set_invoke_task_defaults", { taskDefaults }),
  invokeTasks: () => invoke<InvokeTask[]>("get_invoke_tasks"),
  stopInvokeTask: (id: string) => invoke<void>("stop_invoke_task", { id }),
  pausedThreads: () => invoke<PausedThread[]>("get_paused_threads"),
  readTaskLog: (threadId: string, offset: number) => invoke<LogChunk>("read_task_log", { threadId, offset }),
  activity: (limit = 200) => invoke<ActivityEntry[]>("get_activity", { limit }),
  resultsSummary: (days: number) => invoke<ResultsSummary>("results_summary", { days }),
  onInvokeActivity: (handler: (entry: ActivityEntry) => void) =>
    listen<ActivityEntry>("invoke-activity", (event) => handler(event.payload)),
  onInvokeResumed: (handler: (resumed: { threads: PausedThread[]; by_user: boolean }) => void) =>
    listen<{ threads: PausedThread[]; by_user: boolean }>("invoke-resumed", (event) => handler(event.payload)),
  onInvokeAutoWoke: (handler: (accounts: string[]) => void) =>
    listen<string[]>("invoke-auto-woke", (event) => handler(event.payload)),
  setAccountInvokeAllowed: (id: string, allowed: boolean) =>
    invoke<AccountView>("set_account_invoke_allowed", { id, allowed }),
  invokeFailover: () => invoke<SwitchAccounts | null>("get_invoke_failover"),
  cancelInvokeFailover: () => invoke<void>("cancel_invoke_failover"),
  onInvokeFailoverWaiting: (handler: (waiting: SwitchAccounts | null) => void) =>
    listen<SwitchAccounts | null>("invoke-failover-waiting", (event) => handler(event.payload)),
  invokePause: () => invoke<InvokePause | null>("get_invoke_pause"),
  resumeInvoke: () => invoke<void>("resume_invoke"),
  onInvokePaused: (handler: (pause: InvokePause | null) => void) =>
    listen<InvokePause | null>("invoke-paused", (event) => handler(event.payload)),
  // Rust reports a verified Invoke Mode failover with account IDs only.
  onInvokeAccountSwitched: (handler: (switched: InvokeSwitch) => void) =>
    listen<InvokeSwitch>("invoke-account-switched", (event) => handler(event.payload)),
  updateDelivery: () => invoke<UpdateDelivery>("get_update_delivery"),
  openLatestRelease: () => invoke<void>("open_latest_release"),
};
