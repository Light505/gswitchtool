import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AppWindow,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  ChevronDown,
  ChevronUp,
  CircleArrowDown,
  CircleArrowUp,
  History,
  House,
  Square,
  Download,
  FileJson,
  FolderOpen,
  Info,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  Terminal,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api, type UpdateDelivery } from "./api";
import {
  createTranslator,
  formatCompactExpiry,
  formatDateTime,
  formatDateTimeWithRelative,
  formatNumber,
  formatPercent,
  formatQuotaResetTime,
  formatRelativeTime,
  resolveLocale,
  type Translator,
} from "./i18n";
import { PALETTES, PALETTE_SWATCHES, SCHEMES, readAppearance, saveAppearance, type Appearance } from "./appearance";
import { RefreshLanes } from "./refreshLanes";
import { quotaRefreshDue } from "./refreshPolicy";
import { describeSetup, describeTypicalTask } from "./setupSummary";
import type {
  AccountView,
  CatalogModel,
  ClaudeSetup,
  ClaudeSetupKind,
  ClaudeModel,
  ClaudeEffort,
  CodexCliInfo,
  CodexCliUpdateFailure,
  InvocationProfile,
  InvocationDefault,
  InvokeTaskKind,
  ActivityEntry,
  ResultsSummary,
  ClaudePlugins,
  AppVersion,
  InvokePause,
  InvokeTask,
  LogItem,
  PausedThread,
  InvokeSettings,
  LiveAccountView,
  MigrationCandidate,
  MigrationPreview,
  OAuthFailureCode,
  OAuthLoginStart,
  OAuthLoginStatus,
  PendingResetView,
  QuotaRefreshFailureCode,
  QuotaView,
  QuotaWindow,
  ResetCreditDetail,
  ResetCreditFailure,
  ResetCreditFailureCode,
  ResetCreditOutcome,
  StorageView,
  SwitchAccounts,
  SwitchFailure,
  SwitchFailureCode,
  TokenUsage,
  WakeOperationView,
} from "./types";
import { aggregateResults, firstTryPercent, formatCost, formatDuration } from "./resultsView";
import { updater, type AvailableUpdate } from "./updater";

type Dialog =
  | "add"
  | "enable-switching"
  | "recover-switch"
  | "recover-reset-credit"
  | "storage-recovery"
  | "reset"
  | "remove"
  | "export"
  | "wake"
  | null;

type AddMethod = "start" | "oauth" | "json" | "api-key" | "migration";
type AccountBusyAction = "refresh" | "wake" | "switch";

// Added by Light505: the sidebar's sections; the choice is a per-computer
// preference kept in browser storage, like the appearance.
const SECTIONS = ["home", "accounts", "claude-code", "results", "settings"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_KEY = "gswitch.section";

function readSection(): Section | null {
  try {
    const value = window.localStorage.getItem(SECTION_KEY);
    return SECTIONS.includes(value as Section) ? (value as Section) : null;
  } catch {
    return null;
  }
}

function saveSection(section: Section) {
  try {
    window.localStorage.setItem(SECTION_KEY, section);
  } catch {
    // Without storage the choice lasts until the window closes.
  }
}

// Added by Light505: the Home "Get started" card remembers two things per
// computer: that the Claude Code section was opened, and that the card is hidden.
const CLAUDE_VISITED_KEY = "gswitch.claudeCodeVisited";
const GET_STARTED_HIDDEN_KEY = "gswitch.getStartedHidden";

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Without storage the flag lasts until the window closes.
  }
}

/** The commands to type in Claude Code, each with a Copy button. */
function PluginCommands({ router, t }: { router: boolean; t: Translator }) {
  const commands = [
    "/plugin marketplace add Light505/gswitchtool",
    "/plugin install codex@gswitchtool",
    ...(router ? ["/plugin install router@gswitchtool"] : []),
  ];
  const copy = async (command: string, box: HTMLElement | null) => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      if (box) window.getSelection()?.selectAllChildren(box);
    }
  };
  return (
    <div className="plugin-commands">
      {commands.map((command) => (
        <div className="plugin-command" key={command}>
          <code>{command}</code>
          <button
            className="button button-secondary"
            onClick={(event) => void copy(command, event.currentTarget.previousElementSibling as HTMLElement | null)}
            type="button"
          >
            {t("plugins.copy")}
          </button>
        </div>
      ))}
      <p className="home-empty">{t("plugins.restart")}</p>
    </div>
  );
}

interface WatchedLog {
  id: string;
  taskId?: string;
  threadId: string | null;
  title: string;
  focus: number;
}

interface QuotaRefreshEntry {
  promise: Promise<QuotaView>;
  // A user's refresh, as opposed to an automatic read.
  manual: boolean;
  // Whether its provider request has begun, so it can no longer be replaced.
  started: boolean;
}

interface Notice {
  kind: "success" | "error" | "info";
  text: string;
}

interface OAuthFlow extends OAuthLoginStart {
  status: OAuthLoginStatus;
}

type UpdatePhase = "available" | "downloading" | "installing" | "ready" | "error";

interface PendingUpdate {
  update: AvailableUpdate;
  delivery: UpdateDelivery;
  rollback?: boolean;
}

function fileFilters(t: Translator) {
  return [{ name: t("file.accountExports"), extensions: ["json"] }];
}

const resetFailureCodes = new Set<ResetCreditFailureCode>([
  "operation_busy",
  "codex_open",
  "recovery_required",
  "details_unavailable",
  "credits_changed",
  "not_started",
  "provider_rejected",
  "result_unknown",
]);

function asResetCreditFailure(error: unknown): ResetCreditFailure | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && resetFailureCodes.has(code as ResetCreditFailureCode)
    ? { code: code as ResetCreditFailureCode }
    : undefined;
}

function friendlyError(t: Translator, error: unknown, fallback = t("error.actionIncomplete")) {
  const resetFailure = asResetCreditFailure(error);
  if (resetFailure) {
    return t(`resetFailure.${resetFailure.code}`);
  }
  const message = String(error);
  if (/Quit Codex|Codex is running|external Codex|Unable to reliably inspect/i.test(message)) {
    return t("error.quitCodex");
  }
  if (/recovery/i.test(message)) {
    return t("error.resolveRecovery");
  }
  if (/file-backed|file store|required/i.test(message)) {
    return t("error.enableFileStore");
  }
  if (/No account files were selected/i.test(message)) {
    return t("error.importNoFiles");
  }
  if (/migration preview is stale|preview is no longer importable|scan again/i.test(message)) {
    return t("error.migrationStale");
  }
  if (/selected Cockpit folder could not be read|selected Cockpit folder is empty/i.test(message)) {
    return t("error.migrationFolder");
  }
  if (/no more than 64|64 MiB batch limit/i.test(message)) {
    return t("error.importBatchLimit");
  }
  if (/No supported|not valid JSON|Invalid auth/i.test(message)) {
    return t("error.importUnsupported");
  }
  return fallback;
}

const switchFailureCodes = new Set<SwitchFailureCode>([
  "operation_busy",
  "codex_open",
  "account_needs_sign_in",
  "file_store_required",
  "credentials_changed",
  "recovery_required",
  "local_verification_failed",
  "codex_app_server_unavailable",
  "codex_config_unavailable",
  "codex_config_cleanup_failed",
  "current_credential_unreadable",
  "current_account_not_saved",
  "target_check_unavailable",
  "target_workspace_mismatch",
  "post_write_verification_failed",
  "verification_failed",
]);

function asSwitchFailure(error: unknown): SwitchFailure | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && switchFailureCodes.has(code as SwitchFailureCode)
    ? { code: code as SwitchFailureCode }
    : undefined;
}

function switchFailureMessage(t: Translator, error: unknown, account: AccountView) {
  const failure = asSwitchFailure(error);
  const messages = {
    operation_busy: "switch.error.operationBusy",
    codex_open: "switch.error.codexOpen",
    account_needs_sign_in: "switch.error.needsSignIn",
    file_store_required: "switch.error.fileStoreRequired",
    credentials_changed: "switch.error.credentialsChanged",
    recovery_required: "switch.error.recoveryRequired",
    local_verification_failed: "switch.error.localVerificationFailed",
    codex_app_server_unavailable: "switch.error.codexAppServerUnavailable",
    codex_config_unavailable: "switch.error.codexConfigUnavailable",
    codex_config_cleanup_failed: "switch.error.codexConfigCleanupFailed",
    current_credential_unreadable: "switch.error.currentCredentialUnreadable",
    current_account_not_saved: "switch.error.currentAccountNotSaved",
    target_check_unavailable: "switch.error.targetCheckUnavailable",
    target_workspace_mismatch: "switch.error.targetWorkspaceMismatch",
    post_write_verification_failed: "switch.error.postWriteVerificationFailed",
    verification_failed: "switch.error.verificationFailed",
  } as const;
  const key = failure ? messages[failure.code] : messages.verification_failed;
  return t(key, { name: accountPrimaryName(account) });
}

const quotaFailureCodes = new Set<QuotaRefreshFailureCode>([
  "operation_busy", "codex_account_unknown", "authentication", "rate_limited",
  "manual_refresh_needed", "network", "service", "invalid_response", "identity_mismatch", "unavailable",
]);

function quotaFailureCode(error: unknown): QuotaRefreshFailureCode {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unavailable";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && quotaFailureCodes.has(code as QuotaRefreshFailureCode)
    ? code as QuotaRefreshFailureCode : "unavailable";
}

function quotaFailureMessage(t: Translator, code: QuotaRefreshFailureCode) {
  const keys = {
    operation_busy: "quota.failureBusy",
    codex_account_unknown: "quota.failureCodexUnknown",
    authentication: "quota.failureAuthentication",
    manual_refresh_needed: "quota.failureManualRefresh",
    rate_limited: "quota.failureRateLimited",
    network: "quota.failureNetwork",
    service: "quota.failureService",
    invalid_response: "quota.failureInvalidResponse",
    identity_mismatch: "quota.failureIdentity",
    unavailable: "quota.failureUnavailable",
  } as const;
  return t(keys[code]);
}

function oauthFailureMessage(t: Translator, code: OAuthFailureCode) {
  const keys = {
    not_completed: "oauth.failureNotCompleted",
    timed_out: "oauth.failureTimedOut",
    identity_mismatch: "oauth.failureIdentity",
    authentication: "oauth.failureAuthentication",
    network: "oauth.failureNetwork",
    local_codex: "oauth.failureLocalCodex",
    verification_failed: "oauth.failureVerification",
    save_failed: "oauth.failureSave",
    unavailable: "oauth.failureUnavailable",
  } as const;
  return t(keys[code]);
}

function removeFailureMessage(t: Translator, error: unknown) {
  const message = String(error);
  if (/another gswitch operation is already in progress/i.test(message)) {
    return t("remove.operationBusy");
  }
  if (/active codex account cannot be removed/i.test(message)) {
    return t("remove.activeAccount");
  }
  if (/recover a previous switch before starting another/i.test(message)) {
    return t("remove.recoveryRequired");
  }
  if (/unfinished reset/i.test(message)) {
    return t("remove.pendingReset");
  }
  return t("remove.failed");
}

// A projection Rust saved after this view loaded it, such as the quota read
// after a reset, replaces the in-memory copy. An older saved copy does not.
function mergeNewerQuotas(current: Record<string, QuotaView>, saved: Record<string, QuotaView>) {
  const next = { ...current };
  for (const [accountId, quota] of Object.entries(saved)) {
    const held = next[accountId];
    if (!held || (quota.snapshot?.fetched_at_unix_ms ?? 0) > (held.snapshot?.fetched_at_unix_ms ?? 0)) {
      next[accountId] = quota;
    }
  }
  return next;
}

function accountGridHasGlobalMutation(busy: string | null) {
  if (!busy) {
    return false;
  }

  return [
    "import",
    "migration-import",
    "import-json",
    "import-key",
    "save-current",
    "enable-switching",
    "recover-switch",
    "recover-reset-credit",
    "reset-damaged-store",
    "codex-cli-update",
  ].includes(busy) || busy.startsWith("switch:") || busy.startsWith("reset:") || busy.startsWith("remove:");
}

function cliUpdateFailureCode(error: unknown): CodexCliUpdateFailure {
  const code = String(error);
  if (["not_installed", "unsupported", "busy", "codex_open", "update_failed", "verification_failed"].includes(code)) {
    return code as CodexCliUpdateFailure;
  }
  return "update_failed";
}

function codexQuotaWindows(quota: QuotaView | undefined): QuotaWindow[] {
  return quota?.snapshot?.buckets
    .filter((bucket) => bucket.kind === "codex")
    .flatMap((bucket) => bucket.windows) ?? [];
}

function quotaWindowLabel(window: QuotaWindow, t: Translator): string {
  if (window.kind === "five_hour") return t("quota.fiveHour");
  if (window.kind === "weekly") return t("quota.weekly");
  const minutes = window.window_duration_mins;
  if (minutes === 50_400) return t("quota.fiveWeeks");
  if (minutes && minutes % 10_080 === 0) return t("quota.durationWeeks", { count: minutes / 10_080 });
  if (minutes && minutes % 1_440 === 0) return t("quota.durationDays", { count: minutes / 1_440 });
  if (minutes && minutes % 60 === 0) return t("quota.durationHours", { count: minutes / 60 });
  return t("quota.otherWindow");
}

function accountPlan(account: AccountView, t: Translator) {
  return account.kind === "api_key" ? t("account.apiKey") : account.plan_type ? planLabel(account.plan_type, t) : t("account.chatGpt");
}

function planLabel(plan: string, t: Translator) {
  const key = ({
    free: "plan.free",
    plus: "plan.plus",
    pro: "plan.pro",
    team: "plan.team",
  } as const)[plan.trim().toLowerCase() as "free" | "plus" | "pro" | "team"];
  return key ? t(key) : t("plan.other");
}

function migrationSourceLabel(candidate: MigrationCandidate, t: Translator) {
  return candidate.source === "official_codex"
    ? t("migration.sourceOfficial")
    : t("migration.sourceCockpit");
}

function migrationStateLabel(candidate: MigrationCandidate, t: Translator) {
  if (candidate.state === "new") return t("migration.stateNew");
  if (candidate.state === "already_present") return t("migration.stateAlready");
  return t("migration.stateUnsupported");
}

function accountPrimaryName(account: AccountView) {
  if (account.kind === "chat_gpt" && account.email?.trim()) {
    return account.email.trim();
  }
  return account.label;
}

function accountSecondaryName(account: AccountView, primary: string, t: Translator) {
  if (account.kind === "api_key") {
    return t("account.storedLocally");
  }
  const workspace = account.workspace_name?.trim();
  if (workspace && workspace !== primary) {
    return workspace;
  }
  const legacyLabel = account.label.trim();
  if (!workspace && legacyLabel && legacyLabel !== primary) {
    return legacyLabel;
  }
  return undefined;
}

function wakeResultLabel(result: WakeOperationView["results"][number], alternateModel: boolean, t: Translator) {
  const labels = {
    reply_received: "wake.replyReceived",
    rate_limited: "wake.rateLimited",
    needs_sign_in: "wake.needsSignIn",
    sent_not_confirmed: "wake.sentNotConfirmed",
    model_unavailable: "wake.modelUnavailable",
    invalid_request: "wake.invalidRequest",
    service_unavailable: "wake.serviceUnavailable",
    request_rejected: "wake.requestRejected",
    failed: "wake.failed",
    cancelled: "wake.cancelled",
  } as const;
  const label = t(result.result === "model_unavailable" && alternateModel
    ? "wake.alternateModelUnavailable"
    : labels[result.result]);
  const requestState = result.request_state === "not_sent" && result.result !== "cancelled"
    ? `${t("wake.requestNotSent")} · `
    : "";
  const status = result.http_status ? ` (HTTP ${result.http_status})` : "";
  return `${requestState}${label}${status}`;
}

function wakeSummary(wake: WakeOperationView, t: Translator) {
  const counts = { replied: 0, unconfirmed: 0, failed: 0, cancelled: 0 };
  for (const { result } of wake.results) {
    if (result === "reply_received") counts.replied++;
    else if (result === "sent_not_confirmed") counts.unconfirmed++;
    else if (result === "cancelled") counts.cancelled++;
    else counts.failed++;
  }
  return ([
    ["wake.summaryReplied", counts.replied],
    ["wake.summaryUnconfirmed", counts.unconfirmed],
    ["wake.summaryFailed", counts.failed],
    ["wake.summaryCancelled", counts.cancelled],
  ] as const).filter(([, count]) => count > 0).map(([key, count]) => t(key, { count })).join(" · ");
}

// Irreversible actions take two clicks on the same button, as Codex's own
// reset button does. A second click within 300 ms of the first is ignored so a
// double-click cannot act on its own, and pressing anywhere else disarms it.
const CONFIRM_GUARD_MS = 300;

function useConfirmClick() {
  const [armed, setArmed] = useState<string | null>(null);
  const armedAt = useRef(0);

  useEffect(() => {
    if (armed === null) return;
    const disarmElsewhere = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-confirm]")?.getAttribute("data-confirm") !== armed) {
        setArmed(null);
      }
    };
    document.addEventListener("pointerdown", disarmElsewhere, true);
    return () => document.removeEventListener("pointerdown", disarmElsewhere, true);
  }, [armed]);

  const click = (id: string, action: () => void) => {
    if (armed !== id) {
      setArmed(id);
      armedAt.current = Date.now();
      return;
    }
    if (Date.now() - armedAt.current < CONFIRM_GUARD_MS) {
      return;
    }
    setArmed(null);
    action();
  };

  return { armed, click, disarm: () => setArmed(null) };
}

function Modal({
  title,
  children,
  onClose,
  t,
  wide = false,
  dismissible = true,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  t: Translator;
  wide?: boolean;
  dismissible?: boolean;
  className?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((control) => (control.tagName === "SUMMARY" || !control.closest("details:not([open])")) && getComputedStyle(control).visibility !== "hidden");
    if (controls.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.currentTarget === event.target) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby="modal-title"
        aria-modal="true"
        className={"modal-card" + (wide ? " modal-wide" : "") + (className ? ` ${className}` : "")}
        role="dialog"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <div className="modal-header-actions">
            <button aria-label={t("common.closeDialog", { title })} className="icon-button" disabled={!dismissible} onClick={onClose} type="button">
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

function PopoverMenu({
  className,
  label,
  title,
  popoverLabel,
  icon,
  children,
}: {
  className: string;
  label: string;
  title?: string;
  popoverLabel?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  return (
    <div
      className={className}
      ref={rootRef}
      onBlur={(event) => {
        // WebKit does not focus a clicked button, so a missing target is not
        // proof that focus left the menu; the pointer listener covers that.
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={title}
        type="button"
      >
        {icon}
      </button>
      {open ? (
        <div
          aria-label={popoverLabel}
          className={className.split(" ").map((name) => name + "-popover").join(" ")}
          id={popoverId}
          onClick={(event) => {
            if (!(event.target instanceof Element) || !event.target.closest("button")) return;
            // Return focus first so a dialog opened by this action restores it
            // to the trigger rather than to a removed menu item.
            triggerRef.current?.focus();
            setOpen(false);
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function QuotaResetTime({ timestamp, t, formatLocale }: {
  timestamp: number;
  t: Translator;
  formatLocale: string;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  useLayoutEffect(() => {
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [timestamp]);

  const fullTime = formatDateTime(timestamp, formatLocale);
  const passed = timestamp * 1000 <= nowMs;
  const [relative, absolute] = formatQuotaResetTime(timestamp, formatLocale, nowMs).split(" · ");
  return (
    <time
      aria-label={passed
        ? `${t("quota.resetTimePassed")}: ${fullTime}`
        : t("quota.resets", { time: fullTime })}
      className="quota-reset-time"
      data-full-time={passed ? `${fullTime} · ${t("quota.resetTimePassed")}` : t("quota.resets", { time: fullTime })}
      dateTime={new Date(timestamp * 1000).toISOString()}
      tabIndex={0}
    >
      {passed ? t("quota.resetTimePassed") : <><span>{relative}</span><span className="quota-reset-date"> · {absolute}</span></>}
    </time>
  );
}

function QuotaAlert({ accountName, failure, id, lastSuccess, formatLocale, t }: {
  accountName: string;
  failure?: QuotaRefreshFailureCode;
  id: string;
  lastSuccess?: number;
  formatLocale: string;
  t: Translator;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ top: 26, left: -4 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!rootRef.current || !detailsRef.current) return;
      const anchor = rootRef.current.getBoundingClientRect();
      const details = detailsRef.current.getBoundingClientRect();
      const below = anchor.bottom + 4;
      const above = anchor.top - details.height - 4;
      const top = below + details.height <= window.innerHeight - 8 ? below
        : above >= 8 ? above : Math.max(8, window.innerHeight - details.height - 8);
      const left = Math.max(8, Math.min(anchor.left - 4, window.innerWidth - details.width - 8));
      const next = { top: top - anchor.top, left: left - anchor.left };
      setPosition((current) => current.top === next.top && current.left === next.left ? current : next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, failure, lastSuccess, formatLocale, t]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  return (
    <span
      className="quota-alert"
      data-open={open}
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!rootRef.current?.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        aria-controls={id}
        aria-describedby={id}
        aria-expanded={open}
        aria-label={t(failure ? "quota.refreshErrorFor" : "quota.pendingFor", { name: accountName })}
        className="quota-alert-button"
        onClick={() => setOpen(true)}
        type="button"
      ><CircleAlert size={15} /></button>
      <span className="quota-alert-tooltip" hidden={!open} id={id} ref={detailsRef} role="tooltip" style={position}>
        <strong>{t(failure ? "quota.refreshErrorLabel" : "quota.pending")}</strong>
        {failure ? <span>{quotaFailureMessage(t, failure)}</span> : null}
        {lastSuccess && lastSuccess > 0 && lastSuccess <= Date.now() ? (
          <span>{t("quota.lastUpdated", { time: formatDateTimeWithRelative(lastSuccess / 1000, formatLocale) })}</span>
        ) : null}
      </span>
    </span>
  );
}

function QuotaMeter({
  accountName,
  label,
  window,
  status,
  failure,
  failureId,
  lastSuccess,
  t,
  formatLocale,
}: {
  accountName: string;
  label: string;
  window?: QuotaWindow;
  status?: QuotaView["status"];
  failure?: QuotaRefreshFailureCode;
  failureId?: string;
  lastSuccess?: number;
  t: Translator;
  formatLocale: string;
}) {
  const known = status === "fresh" || status === "stale";
  const remaining = window?.remaining_percent;
  const value = typeof remaining === "number" ? Math.max(0, Math.min(100, remaining)) : undefined;

  return (
    <div className={"quota-meter" + (status === "stale" ? " quota-meter-stale" : "")}>
      <div className="quota-heading">
        <span className="quota-label">{label}{failureId && (failure || status === "stale") ? (
          <QuotaAlert accountName={accountName} failure={failure} id={failureId} lastSuccess={lastSuccess} formatLocale={formatLocale} t={t} />
        ) : null}</span>
        <strong>{value === undefined || !known ? "—" : status === "stale"
          ? t("quota.previousValue", { value: formatPercent(value, formatLocale) })
          : formatPercent(value, formatLocale)}</strong>
      </div>
      <div
        aria-label={t("quota.remaining", { label })}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={status === "fresh" ? value : undefined}
        className="quota-track"
        role={value === undefined || status !== "fresh" ? undefined : "progressbar"}
      >
        <span
          className={value !== undefined && value < 15 ? "quota-low" : ""}
          style={{ width: String(value ?? 0) + "%" }}
        />
      </div>
      {status !== "stale" || value === undefined ? <small>
        {!known || value === undefined
          ? t("quota.notAvailable")
          : window?.resets_at
              ? <QuotaResetTime timestamp={window.resets_at} formatLocale={formatLocale} t={t} />
              : t("quota.resetTimeUnavailable")}
      </small> : null}
    </div>
  );
}

function AccountCard({
  account,
  quota,
  active,
  busyAction,
  globalBusy,
  onSwitch,
  onWake,
  onRefresh,
  onReset,
  resetRecoveryRequired,
  onRemove,
  onCopyEmail,
  onReauthenticate,
  onApply,
  reauthenticationAvailable,
  quotaFailure,
  selectionMode,
  selected,
  onSelectionChange,
  invokeMode,
  onInvokeAllowedChange,
  t,
  formatLocale,
  now,
}: {
  account: AccountView;
  quota?: QuotaView;
  active: boolean;
  busyAction?: AccountBusyAction;
  globalBusy: boolean;
  onSwitch: () => void;
  onWake: () => void;
  onRefresh: () => void;
  onReset: () => void;
  resetRecoveryRequired: boolean;
  onRemove: () => void;
  onCopyEmail: () => void;
  onReauthenticate: () => void;
  onApply: () => void;
  reauthenticationAvailable: boolean;
  quotaFailure?: QuotaRefreshFailureCode;
  selectionMode: boolean;
  selected: boolean;
  onSelectionChange: () => void;
  invokeMode: boolean;
  onInvokeAllowedChange: (allowed: boolean) => void;
  t: Translator;
  formatLocale: string;
  now: number;
}) {
  const credits = quota?.snapshot?.reset_credits;
  const isApiKey = account.kind === "api_key";
  const primaryName = accountPrimaryName(account);
  const secondaryName = accountSecondaryName(account, primaryName, t);
  const controlsBusy = globalBusy || busyAction !== undefined;
  const signInRequired = account.sign_in_required || reauthenticationAvailable;

  return (
    <article className={"account-card" + (active ? " account-active" : "") + (selected ? " account-selected" : "")}>
      <div className="account-card-head">
        <div className="account-identity">
          {selectionMode ? (
            <label className="account-select-control">
              <input
                aria-label={t("accounts.selectAccount", { name: primaryName })}
                checked={selected}
                onChange={onSelectionChange}
                type="checkbox"
              />
            </label>
          ) : null}
          <div className="account-avatar" aria-hidden="true">
            {primaryName.slice(0, 1).toUpperCase()}
          </div>
          <div className="account-copy">
            <h3 title={primaryName}>{primaryName}</h3>
            {secondaryName ? <p title={secondaryName}>{secondaryName}</p> : null}
          </div>
        </div>
        {!selectionMode ? (
          <PopoverMenu
            className="card-menu"
            icon={<MoreHorizontal size={18} />}
            label={t("account.moreActions", { name: primaryName })}
          >
            {account.email ? <button onClick={onCopyEmail} type="button"><Copy size={15} />{t("account.copyEmail")}</button> : null}
            {!isApiKey ? <button disabled={controlsBusy} onClick={onReauthenticate} type="button"><AppWindow size={15} />{t("account.signInAgain")}</button> : null}
            <button
              className="card-menu-danger"
              aria-label={t("account.remove", { name: primaryName })}
              disabled={active || controlsBusy}
              onClick={onRemove}
              type="button"
            >
              <Trash2 size={15} />
              {t("common.removeAccount")}
            </button>
          </PopoverMenu>
        ) : null}
      </div>

      <div className="account-badges">
        {active ? <span className="badge badge-active"><Check size={13} /> {t("account.active")}</span> : null}
        <span className="badge">{accountPlan(account, t)}</span>
        {signInRequired ? <span className="badge badge-error">{t("account.signInRequired")}</span> : null}
        {!signInRequired && active && account.needs_apply ? <span className="badge badge-muted">{t("account.pendingApply")}</span> : null}
      </div>

      {isApiKey ? (
        <div className="api-key-state">
          <KeyRound size={18} />
          <div>
            <strong>{t("account.savedNoBillableCheck")}</strong>
            <p>{t("account.apiKeyDescription")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className={"quota-pair" + (codexQuotaWindows(quota).length === 1 ? " quota-pair-single" : "")}>
            {codexQuotaWindows(quota).length ? codexQuotaWindows(quota).map((window, index) => (
              <QuotaMeter
                accountName={primaryName}
                failure={index === 0 ? quotaFailure : undefined}
                failureId={index === 0 ? "quota-error-" + account.id : undefined}
                lastSuccess={quota?.snapshot?.fetched_at_unix_ms}
                formatLocale={formatLocale}
                key={index}
                label={quotaWindowLabel(window, t)}
                status={quota?.status}
                t={t}
                window={window}
              />
            )) : <QuotaMeter accountName={primaryName} failure={quotaFailure} failureId={"quota-error-" + account.id} lastSuccess={quota?.snapshot?.fetched_at_unix_ms} formatLocale={formatLocale} label={t("quota.otherWindow")} status={quota?.status} t={t} />}
          </div>
          <div className="credit-row">
            <span className="credit-count">
              {t("credit.resetCredits")}
              <strong>{credits ? formatNumber(credits.available_count, formatLocale) : "—"}</strong>
            </span>
            {credits?.available_count && credits.available_count > 0 ? (
              <button className="text-button" onClick={onReset} type="button">
                {resetRecoveryRequired ? t("common.recoveryRequired") : t("common.details")}
                <ChevronRight size={15} />
              </button>
            ) : null}
            {credits?.nearest_expiry ? <small className="credit-expiry" tabIndex={0} data-full-time={formatDateTime(credits.nearest_expiry, formatLocale)} aria-label={t("credit.earliest", { time: formatDateTime(credits.nearest_expiry, formatLocale) })}>{formatCompactExpiry(credits.nearest_expiry, formatLocale)}</small> : null}
          </div>
          {invokeMode && !selectionMode ? (
            <label className="invoke-allow-row">
              <span>{t("invoke.allowAccount")}</span>
              <input
                aria-label={t("invoke.allowAccountFor", { name: primaryName })}
                checked={account.invoke_allowed === true}
                className="switch-input"
                disabled={controlsBusy}
                onChange={(event) => onInvokeAllowedChange(event.currentTarget.checked)}
                role="switch"
                type="checkbox"
              />
            </label>
          ) : null}
        </>
      )}

      {!selectionMode ? <div className="card-footer">
        {!isApiKey ? <button
          aria-label={t("account.refresh", { name: primaryName })}
          className="icon-button"
          disabled={controlsBusy}
          onClick={onRefresh}
          type="button"
        >
          <RefreshCw className={busyAction === "refresh" ? "spin" : ""} size={17} />
        </button> : null}
        {!isApiKey && quota?.snapshot?.fetched_at_unix_ms ? (
          <small className="quota-updated">
            {now - quota.snapshot.fetched_at_unix_ms < 60_000
              ? t("quota.updatedJustNow")
              : t("quota.updatedAgo", { time: formatRelativeTime(quota.snapshot.fetched_at_unix_ms / 1000, formatLocale, now) })}
          </small>
        ) : null}
        <div className="card-footer-actions">
          {!isApiKey && !signInRequired ? (
            <button
              aria-label={t("account.wake", { name: primaryName })}
              className="button button-secondary"
              disabled={controlsBusy}
              onClick={onWake}
              type="button"
            >
              {busyAction === "wake" ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}
              {t("common.wake")}
            </button>
          ) : null}
          <button
            aria-label={t(signInRequired ? "account.signInAgain" : active && account.needs_apply ? "account.apply" : active ? "account.current" : "account.switch", { name: primaryName })}
            className="button button-primary"
            disabled={controlsBusy || (active && !account.needs_apply && !signInRequired)}
            onClick={signInRequired ? onReauthenticate : active && account.needs_apply ? onApply : onSwitch}
            type="button"
          >
            {busyAction === "switch" ? <LoaderCircle className="spin" size={15} /> : signInRequired ? <AppWindow size={15} /> : <ArrowRightLeft size={15} />}
            {signInRequired ? t("account.signInAgain") : active && account.needs_apply ? t("account.apply") : active ? t("common.current") : t("common.switch")}
          </button>
        </div>
      </div> : null}
    </article>
  );
}

interface AddAccountMethodsProps {
  busy: boolean;
  onSignIn: () => void;
  onImport: () => void;
  onSelectMethod: (method: "migration" | "json" | "api-key") => void;
  t: Translator;
}

function AddAccountMethods({ busy, onSignIn, onImport, onSelectMethod, t }: AddAccountMethodsProps) {
  return (
    <div className="add-methods">
      <button className="add-method-card add-method-sign-in" disabled={busy} onClick={onSignIn} type="button">
        <span className="method-icon"><AppWindow size={22} /></span>
        <span><strong>{t("add.browserTitle")}</strong>{" "}<small>{t("add.browserDescription")}</small></span>
        <ChevronRight size={18} />
      </button>
      <button className="add-method-card" disabled={busy} onClick={() => onSelectMethod("migration")} type="button">
        <span className="method-icon"><Upload size={22} /></span>
        <span><strong>{t("add.localTitle")}</strong>{" "}<small>{t("add.localDescription")}</small></span>
        <ChevronRight size={18} />
      </button>
      <button className="add-method-card" disabled={busy} onClick={onImport} type="button">
        <span className="method-icon"><FolderOpen size={22} /></span>
        <span><strong>{t("add.fileTitle")}</strong>{" "}<small>{t("add.fileDescription")}</small></span>
        <ChevronRight size={18} />
      </button>
      <details className="add-other-methods">
        <summary>{t("add.otherMethods")}</summary>
        <div>
          <button className="add-method-card" disabled={busy} onClick={() => onSelectMethod("json")} type="button">
            <span className="method-icon"><FileJson size={22} /></span>
            <span><strong>{t("add.jsonTitle")}</strong>{" "}<small>{t("add.jsonDescription")}</small></span>
            <ChevronRight size={18} />
          </button>
          <button className="add-method-card" disabled={busy} onClick={() => onSelectMethod("api-key")} type="button">
            <span className="method-icon"><KeyRound size={22} /></span>
            <span><strong>{t("add.apiKeyTitle")}</strong>{" "}<small>{t("add.apiKeyDescription")}</small></span>
            <ChevronRight size={18} />
          </button>
        </div>
      </details>
    </div>
  );
}

function FirstRun(props: AddAccountMethodsProps) {
  const { t } = props;
  return (
    <section className="first-run">
      <div className="first-run-primary">
        <span className="eyebrow">{t("firstRun.eyebrow")}</span>
        <h2>{t("firstRun.title")}</h2>
        <p>
          {t("firstRun.body")}
        </p>
        <AddAccountMethods {...props} />
      </div>
    </section>
  );
}

function UpdateNotice({
  pending,
  phase,
  progress,
  onInstall,
  onLater,
  onRestart,
  t,
}: {
  pending: PendingUpdate;
  phase: UpdatePhase;
  progress: number | null;
  onInstall: () => void;
  onLater: () => void;
  onRestart: () => void;
  t: Translator;
}) {
  const downloading = phase === "downloading" || phase === "installing";
  const isReleaseDownload = pending.delivery === "release_download";
  const title = pending.rollback && phase === "available"
    ? t("rollback.confirm", { version: pending.update.version })
    : t(({
      available: "update.available",
      downloading: "update.downloadTitle",
      installing: "update.installTitle",
      ready: "update.readyTitle",
      error: "update.failedTitle",
    } as const)[phase], { version: pending.update.version });
  const primaryLabel = isReleaseDownload
    ? t("update.download")
    : phase === "ready"
      ? t("update.restart")
      : phase === "error"
        ? t("update.retry")
        : phase === "installing"
          ? t("update.installing")
          : downloading
            ? t("update.downloading", { progress: progress ?? "…" })
            : t(pending.rollback ? "rollback.install" : "update.install");

  return (
    <section aria-label={title} className="update-notice">
      <div>
        <strong role="status">{title}</strong>
        {isReleaseDownload ? <p>{t("update.debianFallback")}</p>
          : phase === "downloading" ? <p>{t("update.downloading", { progress: progress ?? "…" })}</p>
          : phase === "ready" ? <p>{t("update.restartRequired")}</p>
          : phase === "error" ? <p>{t("update.failed")}</p>
          : pending.rollback && phase === "available"
            ? <p>{t("rollback.warning", { version: pending.update.version })}</p>
          : null}
      </div>
      <div className="update-actions">
        {phase !== "ready" && !downloading ? (
          <button className="button button-quiet" onClick={onLater} type="button">{t("update.later")}</button>
        ) : null}
        <button
          className="button button-primary"
          disabled={downloading}
          onClick={phase === "ready" ? onRestart : onInstall}
          type="button"
        >
          {downloading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          {primaryLabel}
        </button>
      </div>
    </section>
  );
}

// The whitelist is a set of model/effort pairs: efforts differ per model, so
// each model lists only the efforts the installed Codex reports for it.
/** A thread ID shortened to its first characters for display. */
function shortThread(id: string) {
  return id.slice(0, 8);
}

function folderName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function elapsedText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function compactTokens(tokens: number) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(tokens);
}

function tokenBreakdown(usage: TokenUsage, t: Translator, formatLocale: string) {
  const parts: string[] = [];
  const { input_tokens: input, cached_input_tokens: cached, output_tokens: output } = usage;
  if (input != null && cached != null) {
    parts.push(t("log.input", { tokens: compactTokens(Math.max(0, input - cached)) }));
  }
  if (cached != null) {
    const hit = input != null && input > 0
      ? ` (${t("log.cacheHit", { percent: formatPercent(cached / input * 100, formatLocale) })})` : "";
    parts.push(t("log.cached", { tokens: compactTokens(cached) }) + hit);
  }
  if (output != null) parts.push(t("log.output", { tokens: compactTokens(output) }));
  return parts.join(" · ");
}

function usageText(usage: TokenUsage, t: Translator, formatLocale: string) {
  return [
    usage.total_tokens != null ? t("log.tokens", { tokens: compactTokens(usage.total_tokens) }) : "",
    tokenBreakdown(usage, t, formatLocale),
  ].filter(Boolean).join(" · ");
}

function activityText(entry: ActivityEntry, name: (id: string) => string, t: Translator, formatLocale: string) {
  const thread = (id?: string | null) => (id ? t("activity.thread", { thread: shortThread(id) }) : "");
  switch (entry.kind) {
    case "task_started":
      return t("activity.taskStarted", {
        model: entry.model,
        effort: entry.effort,
        write: entry.write ? t("activity.canEdit") : "",
        folder: folderName(entry.cwd),
      });
    case "task_ended":
      if (entry.status === "completed") return t("activity.taskCompleted", { model: entry.model, thread: thread(entry.thread_id) });
      if (entry.status === "stopped") return t("activity.taskStopped", { model: entry.model, thread: thread(entry.thread_id) });
      if (entry.status === "failed" || entry.status === "rejected") {
        return t("activity.taskFailed", {
          model: entry.model,
          code: entry.code ? t("activity.code", { code: entry.code }) : "",
          thread: thread(entry.thread_id),
        });
      }
      return t("activity.taskEnded", { model: entry.model, thread: thread(entry.thread_id) });
    case "task_stopped":
      return t("activity.youStopped", { model: entry.model, thread: thread(entry.thread_id) });
    case "switched":
      return t(
        entry.reason === "priority" ? "activity.switchedPriority" : entry.reason === "model" ? "activity.switchedModel" : "activity.switchedLimit",
        { from: name(entry.from), to: name(entry.to) },
      );
    case "paused":
      return t("activity.paused", {
        until: entry.resumes_at ? t("activity.pausedUntil", { time: formatDateTime(entry.resumes_at, formatLocale) }) : "",
        count: String(entry.threads.length),
      });
    case "resumed":
      return t(entry.by_user ? "activity.resumedByUser" : "activity.resumed", { count: String(entry.threads.length) });
    case "woke":
      return t("activity.woke", { accounts: entry.accounts.map(name).join(", ") });
  }
}

/** Codex's steps for one thread, followed live from its session log. */
function TaskLog({ threadId, title, live, onClose, focus, showHeader, t, formatLocale }: {
  threadId: string | null;
  title: string;
  live: boolean;
  onClose: () => void;
  focus: number;
  showHeader: boolean;
  t: Translator;
  formatLocale: string;
}) {
  const [items, setItems] = useState<LogItem[]>([]);
  const [found, setFound] = useState(true);
  const [tokens, setTokens] = useState<Extract<LogItem, { kind: "tokens" }> | null>(null);
  const offset = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, [focus]);

  useEffect(() => {
    setItems([]);
    setTokens(null);
    setFound(true);
    offset.current = 0;
    if (!threadId) return;
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const chunk = await api.readTaskLog(threadId, offset.current);
        if (disposed) return;
        setFound(chunk.found);
        offset.current = chunk.offset;
        const counts = chunk.items.filter((item) => item.kind === "tokens");
        if (counts.length) {
          const last = counts[counts.length - 1];
          if (last.kind === "tokens") setTokens(last);
        }
        const steps = chunk.items.filter((item) => item.kind !== "tokens");
        if (steps.length) {
          const view = body.current;
          const following = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 48;
          setItems((current) => [...current, ...steps]);
          if (following) {
            window.requestAnimationFrame(() => {
              if (body.current) body.current.scrollTop = body.current.scrollHeight;
            });
          }
        }
      } catch {
        // The next read tries again.
      } finally {
        reading = false;
      }
    };
    void read();
    const interval = window.setInterval(() => void read(), 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [threadId]);

  return (
    <section aria-label={title} className="task-log-window" ref={panel} tabIndex={-1}>
      {showHeader ? (
        <div className="modal-header">
          <h3>{title}</h3>
          <button aria-label={t("common.closeDialog", { title })} className="icon-button" onClick={onClose} type="button">
            <X size={18} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      <div className="task-log-panel">
        <div aria-live="polite" className="task-log" ref={body} role="log">
          {!threadId ? <p className="log-note">{t("log.waiting")}</p> : null}
          {threadId && !found ? <p className="log-note">{t("log.notFound")}</p> : null}
          {items.map((item, index) => {
            switch (item.kind) {
              case "task":
                return <div className="log-task" key={index}><span>{t("log.task")}</span>{item.text}</div>;
              case "message":
                return <div className="log-message" key={index}>{item.text}</div>;
              case "thinking":
                return <div className="log-thinking" key={index}>{item.text}</div>;
              case "command":
                return <div className="log-command" key={index}>{"$ " + item.text}</div>;
              case "output":
                return <pre className="log-output" key={index}>{item.text}</pre>;
              case "patch":
                return <div className="log-patch" key={index}>{t("log.edited", { files: item.files.join(", ") })}</div>;
              case "done":
                return (
                  <div className="log-done" key={index}>
                    {item.seconds != null
                      ? t("log.done", { seconds: formatNumber(item.seconds, formatLocale) })
                      : t("log.doneNoTime")}
                  </div>
                );
              case "stopped":
                return <div className="log-stopped" key={index}>{t("log.stopped")}</div>;
              default:
                return null;
            }
          })}
        </div>
        <p className="task-log-footer">
          <span className={live ? "log-live" : undefined}>{t(live ? "log.live" : "log.ended")}</span>
          {tokens ? <span>{tokenBreakdown(tokens, t, formatLocale) || t("log.tokens", { tokens: formatNumber(tokens.total, formatLocale) })}</span> : null}
          {threadId ? <span title={threadId}>{shortThread(threadId)}</span> : null}
        </p>
      </div>
    </section>
  );
}

/** The Activity history, newest first, growing with live entries while shown. */
function useActivity() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const unlisten = await api.onInvokeActivity((entry) => setEntries((current) => [entry, ...(current ?? [])]));
        if (disposed) unlisten();
        else stop = unlisten;
      } catch {
        // The list still loads; it just does not grow while open.
      }
      try {
        const loaded = await api.activity(1000);
        if (!disposed) setEntries((current) => [...(current ?? []), ...loaded]);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  return { entries, failed };
}

interface ActivityViewProps {
  name: (id: string) => string;
  onViewLog: (threadId: string, threads: string[]) => void;
  t: Translator;
  formatLocale: string;
}

/** One Activity event; `entries` supplies the other logs a View log can offer. */
function ActivityItem({ entry, entries, name, onViewLog, t, formatLocale }: ActivityViewProps & {
  entry: ActivityEntry;
  entries: ActivityEntry[];
}) {
  return (
    <li>
      <time dateTime={new Date(entry.at).toISOString()} title={formatDateTime(entry.at / 1000, formatLocale)}>
        {formatDateTimeWithRelative(entry.at / 1000, formatLocale)}
      </time>
      <span>
        {activityText(entry, name, t, formatLocale)}
        {(entry.kind === "task_ended" || entry.kind === "task_stopped") && entry.usage ? (
          <small className="activity-usage">{usageText(entry.usage, t, formatLocale)}</small>
        ) : null}
        {(entry.kind === "task_ended" || entry.kind === "task_stopped") && entry.thread_id ? (
          <button className="link-button" onClick={() => onViewLog(entry.thread_id!, entries.flatMap((item) =>
            (item.kind === "task_ended" || item.kind === "task_stopped") && item.thread_id ? [item.thread_id] : [],
          ))} type="button">
            {t("activity.viewLog")}
          </button>
        ) : null}
      </span>
    </li>
  );
}

/** Home's five newest Activity events. */
function RecentActivity({ onSeeAll, ...props }: ActivityViewProps & { onSeeAll: () => void }) {
  const { entries, failed } = useActivity();
  const recent = useMemo(() => [...(entries ?? [])].sort((left, right) => right.at - left.at).slice(0, 5), [entries]);
  return (
    <>
      {failed ? <p className="remove-error" role="alert">{props.t("activity.loadFailed")}</p> : null}
      {entries && entries.length === 0 ? <p className="home-empty">{props.t("activity.empty")}</p> : null}
      {recent.length ? (
        <ol className="activity-list">
          {recent.map((entry, index) => <ActivityItem entries={entries ?? []} entry={entry} key={`${entry.at}-${index}`} {...props} />)}
        </ol>
      ) : null}
      <button className="link-button home-see-all" onClick={onSeeAll} type="button">{props.t("home.seeAll")}</button>
    </>
  );
}

const RESULTS_DIFFICULTIES = [
  ["trivial", "results.trivial"], ["small", "results.small"], ["moderate", "results.moderate"],
  ["hard", "results.hard"], ["high-risk", "results.highRisk"],
] as const;

/** How each model did on routed coding tasks, from the read-only results summary. */
function ModelResults({ t }: { t: Translator }) {
  const [days, setDays] = useState(30);
  const [difficulty, setDifficulty] = useState("all");
  const [summary, setSummary] = useState<ResultsSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setSummary(null);
    setFailed(false);
    api.resultsSummary(days).then(
      (result) => { if (current) setSummary(result); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [days, attempt]);

  const rows = useMemo(() => aggregateResults(summary?.rows ?? [], difficulty), [summary, difficulty]);

  return (
    <section aria-labelledby="results-models-heading" className="page-card results-card">
      <h3 className="page-card-title" id="results-models-heading">{t("results.modelsTitle")}</h3>
      <div className="results-controls">
        <span className="results-period">{t("results.summary", { days, tasks: summary?.tasks ?? 0 })}</span>
        <label>{t("results.period")}
          <select onChange={(event) => setDays(Number(event.target.value))} value={days}>
            {[7, 30, 90].map((value) => <option key={value} value={value}>{t("results.days", { days: value })}</option>)}
          </select>
        </label>
        <label>{t("results.difficulty")}
          <select onChange={(event) => setDifficulty(event.target.value)} value={difficulty}>
            <option value="all">{t("results.allDifficulties")}</option>
            {RESULTS_DIFFICULTIES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </label>
      </div>
      {failed ? (
        <p className="remove-error" role="alert">
          {t("results.loadFailed")} <button className="button" onClick={() => setAttempt((value) => value + 1)} type="button">{t("results.retry")}</button>
        </p>
      ) : !summary ? (
        <div className="loading-state"><LoaderCircle className="spin" size={24} />{t("results.loading")}</div>
      ) : summary.tasks === 0 && summary.rows.length === 0 ? (
        <p>{t("results.empty")}</p>
      ) : rows.length === 0 ? (
        <p>{t("results.emptyDifficulty")}</p>
      ) : (
        <>
          <div className="results-table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th scope="col">{t("results.model")}</th>
                  <th scope="col">{t("results.tasks")}</th>
                  <th scope="col">{t("results.firstTime")}</th>
                  <th scope="col">{t("results.time")}</th>
                  <th scope="col">{t("results.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const percent = firstTryPercent(row);
                  return (
                    <tr key={row.key}>
                      <th scope="row">
                        {row.name}
                        {row.samples > 0 ? <span className="badge" title={t("results.trialHint")}>{t("results.trial")}</span> : null}
                      </th>
                      <td>{row.attempts}</td>
                      <td>
                        {percent == null ? t("results.tooFew", { count: row.firstTries }) : (
                          <span className="results-bar-cell">
                            <span aria-hidden="true" className="results-bar"><span style={{ width: `${percent}%` }} /></span>
                            {percent}%
                          </span>
                        )}
                      </td>
                      <td>{formatDuration(row.medianMs)}</td>
                      <td>{formatCost(row.medianUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="results-note">{t("results.note")}</p>
        </>
      )}
    </section>
  );
}

function ActivityPanel({ name, onViewLog, t, formatLocale }: ActivityViewProps) {
  const { entries, failed } = useActivity();

  const summary = useMemo(() => {
    if (!entries) return [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const starts = new Map(entries.filter((entry) => entry.kind === "task_started").map((entry) => [entry.task, entry]));
    const groups = new Map<string, { model: string; effort: string; tasks: number; tokens: number; usage: TokenUsage }>();
    for (const entry of entries) {
      if (entry.kind !== "task_ended" || entry.at < cutoff) continue;
      const start = starts.get(entry.task);
      const effort = start?.kind === "task_started" ? start.effort : "—";
      const key = `${entry.model}\0${effort}`;
      const group = groups.get(key) ?? { model: entry.model, effort, tasks: 0, tokens: 0, usage: { ...entry.usage } };
      if (group.tasks > 0) {
        // Only report totals for fields known for every task in this group.
        for (const field of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const) {
          const previous = group.usage[field];
          const next = entry.usage?.[field];
          group.usage[field] = previous != null && next != null ? previous + next : undefined;
        }
      }
      group.tasks += 1;
      group.tokens += entry.usage?.total_tokens ?? 0;
      groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) => right.tokens - left.tokens);
  }, [entries]);

  return (
    <div className="activity-panel page-card">
        {failed ? <p className="remove-error" role="alert">{t("activity.loadFailed")}</p> : null}
        {entries && entries.length === 0 ? <p>{t("activity.empty")}</p> : null}
        {entries?.length ? (
          <>
          <section className="activity-summary" aria-label={t("activity.summaryTitle")}>
            <h3>{t("activity.summaryTitle")}</h3>
            {summary.length ? <ul>{summary.map((group) => (
              <li key={`${group.model}-${group.effort}`}>
                <strong>{group.model}</strong><span className="badge">{group.effort}</span>
                <span>{t("activity.summaryLine", { tasks: String(group.tasks), tokens: compactTokens(group.tokens) })}</span>
                {tokenBreakdown(group.usage, t, formatLocale) ? <small className="activity-usage">{tokenBreakdown(group.usage, t, formatLocale)}</small> : null}
              </li>
            ))}</ul> : <p>{t("activity.summaryEmpty")}</p>}
          </section>
          <ol className="activity-list">
            {entries.map((entry, index) => (
              <ActivityItem entries={entries} entry={entry} formatLocale={formatLocale} key={`${entry.at}-${index}`}
                name={name} onViewLog={onViewLog} t={t} />
            ))}
          </ol>
          </>
        ) : null}
    </div>
  );
}

/** Saved ChatGPT accounts in the user's Invoke order; unlisted ones follow. */
function orderedAccounts(accounts: AccountView[], priority: string[]) {
  const rank = (account: AccountView) => {
    const index = priority.indexOf(account.id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return accounts.map((account, index) => ({ account, index })).sort((left, right) =>
    rank(left.account) - rank(right.account) || left.index - right.index,
  ).map(({ account }) => account);
}

function ClaudeSetupPanel({ settings, accounts, onSaved, onSaveFailed, t }: {
  settings: InvokeSettings;
  accounts: AccountView[];
  onSaved: (settings: InvokeSettings) => void;
  onSaveFailed: (message: string) => void;
  t: Translator;
}) {
  const [draft, setDraft] = useState<ClaudeSetup>(() => settings.claude_setup);
  const [fastMinRemaining, setFastMinRemaining] = useState(String(settings.claude_setup.codexSpeed.fastMinRemaining));
  const savedSessionLimitK = () => String((settings.claude_setup.sessionLimit ?? 250000) / 1000);
  const [sessionLimitK, setSessionLimitK] = useState(savedSessionLimitK);
  const allowedForCodex = accounts.filter((account) => account.invoke_allowed === true).length;
  const typical = describeTypicalTask(draft);
  const usesCodex = draft.setup === "claude-codex" || (draft.setup === "router" && draft.router.mode !== "claude");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setups: ClaudeSetupKind[] = ["claude-only", "claude-codex", "router"];
  const models: ClaudeModel[] = ["haiku", "sonnet", "opus"];
  const efforts: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
  const toggleWorker = (model: ClaudeModel, effort: ClaudeEffort) => {
    setDraft((current) => {
      const selected = current.router.claudeAllowed[model];
      return { ...current, router: { ...current.router, claudeAllowed: {
        ...current.router.claudeAllowed,
        [model]: efforts.filter((value) => value === effort ? !selected.includes(value) : selected.includes(value)),
      } } };
    });
  };
  const save = async () => {
    const cutoffVisible = usesCodex && draft.codexSpeed.mode !== "normal";
    const cutoff = cutoffVisible ? Number(fastMinRemaining) : settings.claude_setup.codexSpeed.fastMinRemaining ?? 20;
    if (cutoffVisible && (!fastMinRemaining.trim() || !Number.isInteger(cutoff) || cutoff < 0 || cutoff > 90)) {
      setError(t("claudeSetup.fastCutoffError"));
      return;
    }
    const limitK = Number(sessionLimitK);
    if (!sessionLimitK.trim() || !Number.isInteger(limitK) || limitK < 100 || limitK > 1000) {
      setError(t("claudeSetup.sessionLimitError"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.setClaudeSetup({ ...draft, codexSpeed: { ...draft.codexSpeed, fastMinRemaining: cutoff }, sessionLimit: limitK * 1000 }));
    } catch (failure) {
      const message = friendlyError(t, failure, t("claudeSetup.saveError"));
      setError(message);
      onSaveFailed(message);
    } finally {
      setSaving(false);
    }
  };

  // Cancel returns the page to the saved setup.
  const cancel = () => {
    setDraft(settings.claude_setup);
    setFastMinRemaining(String(settings.claude_setup.codexSpeed.fastMinRemaining));
    setSessionLimitK(savedSessionLimitK());
    setError(null);
  };

  return (
      <div className="claude-setup-panel page-card">
        <div aria-label={t("claudeSetup.choose")} className="claude-setup-cards" role="group">
          {setups.map((setup) => (
            <div className="claude-setup-card" data-selected={draft.setup === setup} key={setup}>
              <button aria-pressed={draft.setup === setup} className="claude-setup-choice" disabled={saving}
                onClick={() => setDraft((current) => ({ ...current, setup }))} type="button">
                <strong>{t(`claudeSetup.name.${setup}`)}</strong>
                <span>{t(`claudeSetup.description.${setup}`)}</span>
                {setup === "router" && allowedForCodex >= 2 ? (
                  <em className="claude-setup-tag">{t("claudeSetup.recommended")}</em>
                ) : null}
              </button>
            </div>
          ))}
        </div>
        <section aria-labelledby="typical-task-heading" className="typical-task">
          <h3 className="typical-task-title" id="typical-task-heading">{t("typical.title")}</h3>
          <ol className="typical-task-steps">
            {typical.steps.map((step, index) => (
              <li key={step.label}>
                <span className="typical-task-label">{index + 1} · {t(step.label)}</span>
                <span>{t(step.text)}</span>
              </li>
            ))}
          </ol>
          {typical.note ? <p className="claude-setup-note">{t(typical.note)}</p> : null}
        </section>
        {draft.setup === "router" ? (
          <details className="claude-fine-tune">
            <summary>{t("claudeSetup.fineTune")}</summary>
          <div className="claude-router-options">
            <div className="claude-option">
            <label className="claude-router-mode">
              <span>{t("claudeSetup.mode")}</span>
              <select disabled={saving} value={draft.router.mode}
                onChange={(event) => setDraft((current) => ({ ...current, router: { ...current.router, mode: event.target.value as ClaudeSetup["router"]["mode"] } }))}>
                <option value="mixed">{t("claudeSetup.mode.mixed")}</option>
                <option value="claude">{t("claudeSetup.mode.claude")}</option>
                <option value="codex">{t("claudeSetup.mode.codex")}</option>
              </select>
            </label>
            <p className="claude-setup-note">{t("claudeSetup.modeNote")}</p>
            </div>
            <div className="claude-worker-grid">
              <table>
                <caption>{t("claudeSetup.workers")}</caption>
                <thead><tr><th scope="col">{t("claudeSetup.model")}</th>{efforts.map((effort) => <th key={effort} scope="col">{effort}</th>)}</tr></thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={model}>
                      <th scope="row">{model === "haiku" ? "Haiku" : model === "sonnet" ? "Sonnet" : "Opus"}</th>
                      {efforts.map((effort) => (
                        <td key={effort}>
                          <input aria-label={t("claudeSetup.workerEffort", { model, effort })}
                            checked={draft.router.claudeAllowed[model].includes(effort)} disabled={saving}
                            onChange={() => toggleWorker(model, effort)} type="checkbox" />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="claude-setup-note">{t("claudeSetup.costNote")}</p>
            {draft.router.mode === "claude" ? (
              <div className="claude-option">
              <label className="claude-router-mode">
                <span>{t("claudeSetup.review")}</span>
                <select disabled={saving} value={draft.router.claudeOnlyReview}
                  onChange={(event) => setDraft((current) => ({ ...current, router: { ...current.router, claudeOnlyReview: event.target.value as "on" | "off" } }))}>
                  <option value="on">{t("claudeSetup.on")}</option>
                  <option value="off">{t("claudeSetup.off")}</option>
                </select>
              </label>
              <p className="claude-setup-note">{t("claudeSetup.reviewNote")}</p>
              </div>
            ) : null}
            {draft.router.mode === "mixed" ? (
              <div className="claude-option">
              <label className="claude-router-mode">
                <span>{t("claudeSetup.useFirst")}</span>
                <select disabled={saving} value={draft.router.prefer}
                  onChange={(event) => setDraft((current) => ({ ...current, router: { ...current.router, prefer: event.target.value as ClaudeSetup["router"]["prefer"] } }))}>
                  <option value="codex">{t("claudeSetup.prefer.codex")}</option>
                  <option value="claude">{t("claudeSetup.prefer.claude")}</option>
                  <option value="price">{t("claudeSetup.prefer.price")}</option>
                </select>
              </label>
              <p className="claude-setup-note">{t("claudeSetup.useFirstNote")}</p>
              </div>
            ) : null}
            <div className="claude-option">
            <label className="claude-router-mode claude-check">
              <input type="checkbox" disabled={saving} checked={draft.router.sampling === "on"}
                onChange={(event) => {
                  const sampling = event.target.checked ? "on" : "off";
                  setDraft((current) => ({ ...current, router: { ...current.router, sampling } }));
                }} />
              <span>{t("claudeSetup.sampling")}</span>
            </label>
            <p className="claude-setup-note">{t("claudeSetup.samplingNote")}</p>
            </div>
          </div>
          </details>
        ) : null}
        {usesCodex ? (
          <div className="claude-router-options">
            <div className="claude-option">
            <label className="claude-router-mode">
              <span>{t("claudeSetup.speed")}</span>
              <select disabled={saving} value={draft.codexSpeed.mode}
                onChange={(event) => setDraft((current) => ({ ...current, codexSpeed: { ...current.codexSpeed, mode: event.target.value as ClaudeSetup["codexSpeed"]["mode"] } }))}>
                <option value="normal">{t("claudeSetup.speed.normal")}</option>
                <option value="fast">{t("claudeSetup.speed.fast")}</option>
                <option value="orchestrator">{t("claudeSetup.speed.orchestrator")}</option>
              </select>
            </label>
            <p className="claude-setup-note">{t("claudeSetup.speedNote")}</p>
            </div>
            {draft.codexSpeed.mode !== "normal" ? (
              <label className="claude-router-mode">
                <span>{t("claudeSetup.fastCutoff")}</span>
                <input disabled={saving} max={90} min={0} step={1} type="number" value={fastMinRemaining}
                  onChange={(event) => setFastMinRemaining(event.target.value)} />
              </label>
            ) : null}
          </div>
        ) : null}
        <div className="claude-router-options">
          <div className="claude-option">
            <label className="claude-router-mode">
              <span>{t("claudeSetup.sessionLimit")}</span>
              <input disabled={saving} max={1000} min={100} step={1} type="number" value={sessionLimitK}
                onChange={(event) => setSessionLimitK(event.target.value)} />
            </label>
            <p className="claude-setup-note">{t("claudeSetup.sessionLimitNote")}</p>
          </div>
        </div>
        {error ? <p className="remove-error" role="alert">{error}</p> : null}
        <p className="claude-setup-note">{t("claudeSetup.footer")}</p>
        <div className="modal-actions">
          <button className="button button-quiet" disabled={saving} onClick={cancel} type="button">{t("common.cancel")}</button>
          <button className="button button-primary" disabled={saving} onClick={() => void save()} type="button">
            {saving ? <LoaderCircle className="spin" size={15} /> : null}{t("common.save")}
          </button>
        </div>
      </div>
  );
}

function clampPercent(value: string, min: number, max: number, fallback: number) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && value.trim() !== "" ? Math.min(max, Math.max(min, number)) : fallback;
}

function AccountOrderCard({ order, reserve, saving, error, onMove, onReserve, onSave, t }: {
  order: AccountView[];
  reserve: Record<string, string>;
  saving: boolean;
  error: string | null;
  onMove: (index: number, offset: number) => void;
  onReserve: (id: string, value: string) => void;
  onSave: () => void;
  t: Translator;
}) {
  return (
    <section aria-labelledby="order-card-heading" className="page-card">
      <h3 className="page-card-title" id="order-card-heading">{t("invoke.orderCardTitle")}</h3>
      <div className="invoke-panel">
        <p>{t("invoke.orderIntro")}</p>
        {order.length ? (
          <ol className="invoke-order">
            {order.map((account, index) => {
              const name = accountPrimaryName(account);
              return (
                <li key={account.id}>
                  <span className="invoke-order-rank">{index + 1}</span>
                  <span className="invoke-order-name" title={name}>{name}</span>
                  <span className="badge">{accountPlan(account, t)}</span>
                  {account.invoke_allowed ? null : <span className="badge badge-muted">{t("invoke.notAllowed")}</span>}
                  <label className="invoke-reserve" title={t("invoke.weeklyReserveHint")}>
                    <input
                      aria-label={t("invoke.weeklyReserveFor", { name })}
                      disabled={saving}
                      inputMode="numeric"
                      max={90}
                      min={0}
                      onChange={(event) => onReserve(account.id, event.target.value)}
                      placeholder="0"
                      step={5}
                      type="number"
                      value={reserve[account.id] ?? ""}
                    />
                    <small>{t("invoke.weeklyReserve")} %</small>
                  </label>
                  <span className="invoke-order-actions">
                    <button aria-label={t("invoke.moveUp", { name })} className="icon-button" disabled={saving || index === 0} onClick={() => onMove(index, -1)} type="button"><ChevronUp size={15} /></button>
                    <button aria-label={t("invoke.moveDown", { name })} className="icon-button" disabled={saving || index === order.length - 1} onClick={() => onMove(index, 1)} type="button"><ChevronDown size={15} /></button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : <p>{t("invoke.orderEmpty")}</p>}
        {error ? <p className="remove-error" role="alert">{error}</p> : null}
        {order.length ? (
          <div className="modal-actions">
            <button className="button button-primary" disabled={saving} onClick={onSave} type="button">
              {saving ? <LoaderCircle className="spin" size={15} /> : null}
              {t("common.save")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InvokeSettingsPanel({ settings, accounts, onSaved, onSaveFailed, onOpenAccounts, t }: {
  settings: InvokeSettings;
  accounts: AccountView[];
  onSaved: (settings: InvokeSettings) => void;
  onSaveFailed: (message: string) => void;
  onOpenAccounts: () => void;
  t: Translator;
}) {
  const [minRemaining, setMinRemaining] = useState(String(settings.preferred_min_remaining ?? 20));
  const [maxTasks, setMaxTasks] = useState(String(settings.max_concurrent_tasks ?? 2));
  const [autoWake, setAutoWake] = useState(settings.auto_wake ?? false);
  const clamp = clampPercent;
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(settings.allowed_invocation_profiles.map((profile) => [profile.model, profile.reasoning_efforts])),
  );
  const [taskDefaults, setTaskDefaults] = useState<Partial<Record<InvokeTaskKind, InvocationDefault>>>(() => settings.task_defaults ?? {});
  const taskKinds: InvokeTaskKind[] = ["review", "research", "mechanical", "complex"];

  const loadModels = useCallback(async (refresh: boolean) => {
    setLoadingModels(true);
    setLoadError(null);
    try {
      setCatalog(await api.modelCatalog(refresh));
    } catch {
      setLoadError(t("error.invokeModels"));
    } finally {
      setLoadingModels(false);
    }
  }, [t]);

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  const toggleEffort = (model: string, effort: string) => {
    setDraft((current) => {
      const efforts = current[model] ?? [];
      return {
        ...current,
        [model]: efforts.includes(effort) ? efforts.filter((value) => value !== effort) : [...efforts, effort],
      };
    });
  };

  const save = async () => {
    const profiles: InvocationProfile[] = (catalog ?? []).flatMap((model) => {
      const efforts = model.supported_reasoning_efforts.filter((effort) => draft[model.model]?.includes(effort));
      return efforts.length ? [{ model: model.model, reasoning_efforts: efforts }] : [];
    });
    setSaving(true);
    setSaveError(null);
    try {
      await api.setInvokeProfiles(profiles);
      await api.setInvokePreferences(
        settings.account_priority ?? [],
        clamp(minRemaining, 0, 90, 20),
        clamp(maxTasks, 1, 6, 2),
        autoWake,
      );
      const allowedDefaults = Object.fromEntries(taskKinds.flatMap((kind) => {
        const selected = taskDefaults[kind];
        return selected && draft[selected.model]?.includes(selected.effort) ? [[kind, selected]] : [];
      })) as Partial<Record<InvokeTaskKind, InvocationDefault>>;
      onSaved(await api.setInvokeTaskDefaults(allowedDefaults));
    } catch {
      setSaveError(t("error.invokeSave"));
      onSaveFailed(t("error.invokeSave"));
    } finally {
      setSaving(false);
    }
  };

  return (
      <div className="invoke-panel">
        <h4>{t("invoke.modelsTitle")}</h4>
        <p>{t("invoke.modelsHint")}</p>
        <p>{t("invoke.modelsIntro")}</p>
        {loadingModels && !catalog ? (
          <p className="invoke-loading" role="status"><LoaderCircle className="spin" size={15} />{t("invoke.loadingModels")}</p>
        ) : null}
        {loadError ? <p className="remove-error" role="alert">{loadError}</p> : null}
        {catalog && catalog.length === 0 ? <p>{t("invoke.noModels")}</p> : null}
        {catalog?.length ? (
          <ul className="invoke-models">
            {catalog.map((model) => (
              <li key={model.model}>
                <div className="invoke-model-name">
                  <strong title={model.model}>{model.display_name}</strong>
                  {model.is_default ? <span className="badge">{t("invoke.defaultModel")}</span> : null}
                  {model.only_on ? (() => {
                    const holders = accounts.filter((account) => model.only_on?.includes(account.id));
                    const plans = [...new Set(holders.map((account) => accountPlan(account, t)))];
                    return holders.length ? (
                      <span className="badge badge-exclusive" title={t("invoke.onlyOnTitle", { accounts: holders.map(accountPrimaryName).join(", ") })}>
                        {t("invoke.onlyOn", { plans: plans.join(", ") })}
                      </span>
                    ) : <span className="badge badge-muted">{t("invoke.onNoAccount")}</span>;
                  })() : null}
                </div>
                <div className="invoke-efforts">
                  {model.supported_reasoning_efforts.map((effort) => (
                    <label className="invoke-effort" key={effort}>
                      <input
                        aria-label={t("invoke.effortFor", { effort, model: model.display_name })}
                        checked={draft[model.model]?.includes(effort) ?? false}
                        disabled={saving}
                        onChange={() => toggleEffort(model.model, effort)}
                        type="checkbox"
                      />
                      <span>{effort}</span>
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <h4>{t("invoke.taskDefaultsTitle")}</h4>
        <p>{t("invoke.taskDefaultsIntro")}</p>
        <ul className="invoke-task-defaults">
          {taskKinds.map((kind) => {
            const allowedModels = (catalog ?? []).filter((model) => draft[model.model]?.length);
            const selected = taskDefaults[kind];
            const selectedModel = allowedModels.find((model) => model.model === selected?.model);
            const efforts = selectedModel ? selectedModel.supported_reasoning_efforts.filter((effort) => draft[selectedModel.model]?.includes(effort)) : [];
            return (
              <li key={kind}>
                <strong>{t(`invoke.taskKind.${kind}`)}</strong>
                <label>
                  <span className="sr-only">{t("invoke.defaultModelFor", { kind: t(`invoke.taskKind.${kind}`) })}</span>
                  <select
                    aria-label={t("invoke.defaultModelFor", { kind: t(`invoke.taskKind.${kind}`) })}
                    disabled={saving || loadingModels}
                    onChange={(event) => {
                      const model = allowedModels.find((item) => item.model === event.target.value);
                      setTaskDefaults((current) => {
                        const next = { ...current };
                        if (!model) delete next[kind];
                        else next[kind] = { model: model.model, effort: model.supported_reasoning_efforts.find((effort) => draft[model.model]?.includes(effort)) ?? "" };
                        return next;
                      });
                    }}
                    value={selectedModel?.model ?? ""}
                  >
                    <option value="">{t("invoke.noDefault")}</option>
                    {allowedModels.map((model) => <option key={model.model} value={model.model}>{model.display_name}</option>)}
                  </select>
                </label>
                <label>
                  <span className="sr-only">{t("invoke.defaultEffortFor", { kind: t(`invoke.taskKind.${kind}`) })}</span>
                  <select
                    aria-label={t("invoke.defaultEffortFor", { kind: t(`invoke.taskKind.${kind}`) })}
                    disabled={saving || !selectedModel}
                    onChange={(event) => setTaskDefaults((current) => ({ ...current, [kind]: { model: selectedModel!.model, effort: event.target.value } }))}
                    value={efforts.includes(selected?.effort ?? "") ? selected?.effort : ""}
                  >
                    {efforts.length ? efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>) : <option value="">—</option>}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
        <p>
          {t("invoke.accountsPointer")}{" "}
          <button className="text-button" onClick={onOpenAccounts} type="button">{t("invoke.openAccounts")}</button>
        </p>
        <div className="invoke-limits">
          <label>
            <span>{t("invoke.minRemaining")}</span>
            <span className="invoke-limit-input">
              <input disabled={saving} inputMode="numeric" max={90} min={0} onChange={(event) => setMinRemaining(event.target.value)} step={5} type="number" value={minRemaining} />
              <small>{t("invoke.minRemainingHint")}</small>
            </span>
          </label>
          <label>
            <span>{t("invoke.maxTasks")}</span>
            <span className="invoke-limit-input">
              <input disabled={saving} inputMode="numeric" max={6} min={1} onChange={(event) => setMaxTasks(event.target.value)} type="number" value={maxTasks} />
              <small>{t("invoke.maxTasksHint")}</small>
            </span>
          </label>
        </div>
        <label className="invoke-toggle">
          <input checked={autoWake} disabled={saving} onChange={(event) => setAutoWake(event.target.checked)} type="checkbox" />
          <span>
            <strong>{t("invoke.autoWake")}</strong>
            <small>{t("invoke.autoWakeHint")}</small>
          </span>
        </label>
        {saveError ? <p className="remove-error" role="alert">{saveError}</p> : null}
        <div className="modal-actions">
          <button className="button button-quiet" disabled={loadingModels || saving} onClick={() => void loadModels(true)} type="button">
            <RefreshCw className={loadingModels ? "spin" : ""} size={15} />
            {t("invoke.refreshModels")}
          </button>
          <button className="button button-primary" disabled={!catalog || loadingModels || saving} onClick={() => void save()} type="button">
            {saving ? <LoaderCircle className="spin" size={15} /> : null}
            {t("common.save")}
          </button>
        </div>
      </div>
  );
}

export default function App() {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [quotas, setQuotas] = useState<Record<string, QuotaView>>({});
  const [quotaFailures, setQuotaFailures] = useState<Record<string, QuotaRefreshFailureCode>>({});
  const [accountSignInNeeded, setAccountSignInNeeded] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState<LiveAccountView | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [pendingReset, setPendingReset] = useState<PendingResetView | null>(null);
  const pendingResetCredit = pendingReset !== null;
  const [discardConfirmation, setDiscardConfirmation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState<Record<string, AccountBusyAction>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [addMethod, setAddMethod] = useState<AddMethod>("start");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const confirm = useConfirmClick();
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreview | null>(null);
  const [migrationRoot, setMigrationRoot] = useState<string | undefined>();
  const [migrationSelection, setMigrationSelection] = useState<string[]>([]);
  const [migrationScanned, setMigrationScanned] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [invokeSettings, setInvokeSettings] = useState<InvokeSettings | null>(null);
  const [invokeSettingsFailed, setInvokeSettingsFailed] = useState(false);
  const [failoverWaiting, setFailoverWaiting] = useState<SwitchAccounts | null>(null);
  const [failoverCancelling, setFailoverCancelling] = useState(false);
  const [invokePause, setInvokePause] = useState<InvokePause | null>(null);
  const [pausedThreads, setPausedThreads] = useState<PausedThread[]>([]);
  const [tasks, setTasks] = useState<InvokeTask[]>([]);
  const [taskClock, setTaskClock] = useState(() => Date.now());
  const [watching, setWatching] = useState<WatchedLog[]>([]);
  const [historyThreads, setHistoryThreads] = useState<string[]>([]);
  const watchLog = (log: Omit<WatchedLog, "focus">) => {
    setWatching((current) => {
      const held = current.find((item) => item.id === log.id || (log.threadId && item.threadId === log.threadId));
      if (held) return current.map((item) => item === held ? { ...item, focus: item.focus + 1 } : item);
      return [...current.slice(-3), { ...log, focus: 0 }];
    });
  };
  const closeLog = (id: string) => setWatching((current) => current.filter((log) => log.id !== id)
    .map((log, index) => index === 0 ? { ...log, focus: log.focus + 1 } : log));

  useEffect(() => {
    // Retain a thread assigned after Watch opened, including after its task ends.
    setWatching((current) => {
      let changed = false;
      const next = current.map((log) => {
        const threadId = tasks.find((task) => task.id === log.taskId)?.thread_id;
        if (!threadId || threadId === log.threadId) return log;
        changed = true;
        return { ...log, threadId };
      });
      return changed ? next : current;
    });
  }, [tasks]);
  const [invokeResuming, setInvokeResuming] = useState(false);
  const [oauth, setOauth] = useState<OAuthFlow | null>(null);
  const [oauthStatusUnavailable, setOauthStatusUnavailable] = useState(false);
  const [oauthTarget, setOauthTarget] = useState<AccountView | null>(null);
  const [wake, setWake] = useState<WakeOperationView | null>(null);
  const [wakeStatusUnavailable, setWakeStatusUnavailable] = useState(false);
  const [resetAccount, setResetAccount] = useState<AccountView | null>(null);
  const [removeAccount, setRemoveAccount] = useState<AccountView | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [redeemingCredit, setRedeemingCredit] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [cliInfo, setCliInfo] = useState<CodexCliInfo | null>(null);
  const [cliChecking, setCliChecking] = useState(false);
  // False until the first Codex CLI check returns, so Settings never says "not found" too early.
  const [cliChecked, setCliChecked] = useState(false);
  const [cliResult, setCliResult] = useState<{ kind: "updated" | "sameVersion"; version: string } | null>(null);
  const [cliError, setCliError] = useState<CodexCliUpdateFailure | "inspect_failed" | "open_guide" | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("available");
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const jsonRef = useRef<HTMLTextAreaElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const dismissedUpdateVersions = useRef(new Set<string>());
  const updateCheckInFlight = useRef(false);
  const quotaRefreshes = useRef(new Map<string, QuotaRefreshEntry>());
  // Automatic reads go one at a time; a user's refresh gets its own lane of
  // up to three read-only reads; only a saved sign-in that needs the official
  // token refresh takes the credential lock, one account at a time.
  const refreshLanes = useRef(new RefreshLanes({ background: 1, manual: 3, signIn: 1 }));
  const lastQuotaAttempt = useRef(new Map<string, number>());
  const refreshInputs = useRef<{
    accounts: AccountView[];
    quotas: Record<string, QuotaView>;
    quotaFailures: Record<string, QuotaRefreshFailureCode>;
    activeId?: string;
  }>({ accounts: [], quotas: {}, quotaFailures: {} });
  const [clock, setClock] = useState(() => Date.now());
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(null);
  const accountOperations = useRef(new Set<string>());
  const snapshotSequence = useRef(0);
  const initialSnapshotLoaded = useRef(false);
  const [label, setLabel] = useState("");
  const locale = useMemo(() => resolveLocale(), []);
  const t = useMemo(() => createTranslator(), []);
  // No section until the first snapshot when none was chosen before: Home,
  // or Accounts when nothing is saved yet.
  const [section, setSection] = useState<Section | null>(readSection);
  const selectSection = (next: Section) => {
    setSection(next);
    saveSection(next);
  };
  const sectionRef = useRef(section);
  sectionRef.current = section;
  // The Claude Code page stays mounted once opened, so its drafts, saving state
  // and errors survive navigation; a save that fails elsewhere is also toasted.
  const [claudeCodeOpened, setClaudeCodeOpened] = useState(false);
  useEffect(() => {
    if (section === "claude-code") setClaudeCodeOpened(true);
  }, [section]);
  const [claudeVisited, setClaudeVisited] = useState(() => readFlag(CLAUDE_VISITED_KEY));
  useEffect(() => {
    if (section !== "claude-code") return;
    setClaudeVisited(true);
    saveFlag(CLAUDE_VISITED_KEY);
  }, [section]);
  const [getStartedHidden, setGetStartedHidden] = useState(() => readFlag(GET_STARTED_HIDDEN_KEY));
  const [claudePlugins, setClaudePlugins] = useState<ClaudePlugins | null>(null);
  const refreshClaudePlugins = () => {
    void api.claudePlugins().then(setClaudePlugins, () => setClaudePlugins(null));
  };
  useEffect(() => {
    if (section === "home" || section === "settings") refreshClaudePlugins();
  }, [section]);
  // The "Order Claude uses" draft lives here so it survives navigation; null
  // means "as saved".
  const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
  const [reserveDraft, setReserveDraft] = useState<Record<string, string> | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const reportSaveFailure = (text: string) => {
    if (sectionRef.current !== "claude-code") setNotice({ kind: "error", text });
  };
  // A sidebar click moves focus to the new page's heading; first load does not.
  const focusPageHeading = useRef(false);
  useEffect(() => {
    if (!focusPageHeading.current) return;
    focusPageHeading.current = false;
    document.querySelector<HTMLElement>(".content .page:not([hidden]) .page-title, .content .accounts-page-title")?.focus();
  }, [section]);
  const watchChoices = [
    ...tasks.map((task) => ({
      id: task.id,
      taskId: task.id,
      threadId: task.thread_id ?? null,
      title: t("log.title", { model: task.model, folder: folderName(task.cwd) }),
    })),
    ...historyThreads.filter((thread) => !tasks.some((task) => task.thread_id === thread)).map((threadId) => ({
      id: threadId,
      threadId,
      title: t("log.historyTitle", { thread: shortThread(threadId) }),
    })),
  ];

  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const timeout = window.setTimeout(() => {
      setNotice((current) => current === notice ? null : current);
    }, notice.kind === "success" ? 4000 : 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const checkCodexCli = async () => {
    setCliChecking(true);
    setCliError(null);
    try {
      setCliInfo(await api.codexCliInfo());
    } catch {
      setCliInfo(null);
      setCliError("inspect_failed");
    } finally {
      setCliChecking(false);
      setCliChecked(true);
    }
  };

  const openSettings = () => {
    // An update's result or failure stays until a new check or update starts.
    if (section !== "settings" && busy !== "codex-cli-update" && !cliResult && !cliError) {
      void checkCodexCli();
    }
    selectSection("settings");
  };

  useEffect(() => {
    if (!loading && section === null) setSection(accounts.length ? "home" : "accounts");
  }, [accounts.length, loading, section]);

  useEffect(() => {
    if (loading) return;
    let closed = false;
    const check = () => {
      void api.codexCliInfo().then((info) => {
        if (!closed) {
          setCliInfo(info);
          setCliChecked(true);
        }
      }).catch(() => {
        if (!closed) {
          setCliInfo(null);
          setCliChecked(true);
        }
      });
    };
    const initial = window.setTimeout(check, 250);
    const interval = window.setInterval(check, 6 * 60 * 60 * 1000);
    return () => {
      closed = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loading]);

  const updateCodexCli = async () => {
    const previousVersion = cliInfo?.version;
    setCliResult(null);
    setCliError(null);
    setBusy("codex-cli-update");
    try {
      const updated = await api.updateCodexCli();
      setCliInfo(await api.codexCliInfo().catch(() => updated));
      setCliResult({ kind: previousVersion === updated.version ? "sameVersion" : "updated", version: updated.version || "—" });
    } catch (error) {
      setCliError(cliUpdateFailureCode(error));
    } finally {
      setBusy(null);
    }
  };

  const requestQuotaRefresh = useCallback((accountId: string, background = false): Promise<QuotaView> => {
    const current = quotaRefreshes.current.get(accountId);
    // A started read, or any read an automatic caller can share, is joined. A
    // user's refresh replaces an automatic read that is still waiting.
    if (current && (background || current.started || current.manual)) {
      return current.promise;
    }

    lastQuotaAttempt.current.set(accountId, Date.now());
    const lanes = refreshLanes.current;
    const entry: QuotaRefreshEntry = { manual: !background, started: false, promise: Promise.resolve() as never };
    const read = () => {
      entry.started = true;
      return api.refreshAccountQuota(accountId, true);
    };
    const attempt = background
      ? lanes.run("background", () => {
        const replacement = quotaRefreshes.current.get(accountId);
        return replacement && replacement !== entry ? replacement.promise : read();
      })
      : lanes.run("manual", read).catch((error: unknown) => {
        if (quotaFailureCode(error) !== "manual_refresh_needed") {
          throw error;
        }
        return lanes.run("signIn", () => api.refreshAccountQuota(accountId, false));
      });
    const request = attempt.then(
      (quota) => {
        setQuotas((current) => ({ ...current, [accountId]: quota }));
        setQuotaFailures((current) => {
          const next = { ...current };
          delete next[accountId];
          return next;
        });
        return quota;
      },
      (error) => {
        const code = quotaFailureCode(error);
        setQuotaFailures((current) => ({ ...current, [accountId]: code }));
        setQuotas((current) => {
          const previous = current[accountId];
          return {
            ...current,
            [accountId]: {
              account_id: accountId,
              status: previous?.snapshot ? "stale" : "unknown",
              snapshot: previous?.snapshot,
            },
          };
        });
        throw error;
      },
    );
    entry.promise = request;
    quotaRefreshes.current.set(accountId, entry);
    const forget = () => {
      if (quotaRefreshes.current.get(accountId) === entry) {
        quotaRefreshes.current.delete(accountId);
      }
    };
    void request.then(forget, forget);
    return request;
  }, []);

  const loadSnapshot = useCallback(async () => {
    const sequence = ++snapshotSequence.current;
    if (!initialSnapshotLoaded.current) setLoading(true);
    try {
      const initial = await api.appSnapshot();
      if (sequence !== snapshotSequence.current) return;
      const activeAccountId = initial.live?.account?.id;
      const nextAccounts = [...initial.accounts].sort(
        (left, right) =>
          Number(right.active || right.id === activeAccountId) -
          Number(left.active || left.id === activeAccountId),
      );
      setAccounts((current) => {
        if (!current.length) return nextAccounts;
        const byId = new Map(nextAccounts.map((account) => [account.id, account]));
        const retained = current.flatMap((account) => byId.has(account.id) ? [byId.get(account.id)!] : []);
        const added = nextAccounts.filter((account) => !current.some((saved) => saved.id === account.id));
        return [...retained, ...added];
      });
      setSelectedAccountIds((current) =>
        current.filter((id) => nextAccounts.some((account) => account.id === id)),
      );
      setStorage(initial.storage);
      setPendingReset(initial.pending_reset ?? null);
      setLive(initial.live || null);
      const savedIds = new Set(nextAccounts.map((account) => account.id));
      setQuotas((current) => Object.fromEntries(Object.entries(current).filter(([id]) => savedIds.has(id))));
      setQuotaFailures((current) => Object.fromEntries(Object.entries(current).filter(([id]) => savedIds.has(id))));
      if (initial.storage.status === "ready") {
        void Promise.allSettled(
          nextAccounts
            .filter((account) => account.kind === "chat_gpt")
            .map(async (account) => [account.id, await api.accountQuota(account.id)] as const),
        ).then((quotaPairs) => {
          if (sequence !== snapshotSequence.current) return;
          const cached = Object.fromEntries(
            quotaPairs.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
          ) as Record<string, QuotaView>;
          setQuotas((current) => mergeNewerQuotas(current, cached));
          const now = Date.now();
          for (const account of nextAccounts) {
            const quota = cached[account.id];
            if (quota && quotaRefreshDue(quota, {
              active: account.active || account.id === activeAccountId,
              focused: false,
              failure: refreshInputs.current.quotaFailures[account.id],
              lastAttemptAt: lastQuotaAttempt.current.get(account.id),
              now,
            })) {
              void requestQuotaRefresh(account.id, true).catch(() => undefined);
            }
          }
        });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        text: friendlyError(t, error, t("error.snapshot")),
      });
    } finally {
      if (sequence === snapshotSequence.current) {
        initialSnapshotLoaded.current = true;
        setLoading(false);
      }
    }
  }, [requestQuotaRefresh, t]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    // Without readable settings the mode control stays hidden and GSwitch
    // behaves as the manual switcher.
    void (async () => {
      try {
        setInvokeSettings(await api.invokeSettings());
      } catch {
        setInvokeSettings(null);
        setInvokeSettingsFailed(true);
      }
    })();
  }, []);

  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  useEffect(() => {
    // An Invoke Mode failover is the one switch the user did not start, so the
    // window reloads and says which accounts were involved.
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const unlisten = await api.onInvokeAccountSwitched(({ from, to, reason }) => {
          const name = (id: string) => {
            const account = accountsRef.current.find((saved) => saved.id === id);
            return account ? accountPrimaryName(account) : t("common.unknown");
          };
          setNotice({
            kind: "info",
            text: t(
              reason === "priority" ? "invoke.switchedPriority" : reason === "model" ? "invoke.switchedModel" : "invoke.switched",
              { from: name(from), to: name(to) },
            ),
          });
          void loadSnapshot();
        });
        if (disposed) unlisten();
        else stop = unlisten;
      } catch {
        // Without the event the next snapshot still shows the active account.
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [loadSnapshot, t]);

  useEffect(() => {
    // A Codex the user opened blocks an Invoke Mode switch; GSwitch asks the
    // user to close it, as a manual switch would, and the switch then continues.
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const unlisten = await api.onInvokeFailoverWaiting(setFailoverWaiting);
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
        setFailoverWaiting(await api.invokeFailover());
      } catch {
        setFailoverWaiting(null);
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    // Every account Invoke Mode may use ran out of Codex usage; Claude was told
    // to pause until the reset or until the user resumes.
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const unlisten = await api.onInvokePaused(setInvokePause);
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
        setInvokePause(await api.invokePause());
      } catch {
        setInvokePause(null);
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    // GSwitch ends the pause at the reset time; read it again then.
    if (invokePause?.resumes_at == null) return;
    const delay = Math.min(Math.max(invokePause.resumes_at * 1000 - Date.now(), 0) + 1000, 2 ** 31 - 1);
    const timer = window.setTimeout(() => {
      void api.invokePause().then(setInvokePause, () => setInvokePause(null));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [invokePause]);

  useEffect(() => {
    // Automatic Wake started some accounts' reset timers; say which.
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const unlisten = await api.onInvokeAutoWoke((ids) => {
          const names = ids.map((id) => {
            const account = accountsRef.current.find((saved) => saved.id === id);
            return account ? accountPrimaryName(account) : t("common.unknown");
          });
          setNotice({ kind: "info", text: t("invoke.autoWoke", { accounts: names.join(", ") }) });
          void loadSnapshot();
        });
        if (disposed) unlisten();
        else stop = unlisten;
      } catch {
        // Without the event the cards still refresh on their schedule.
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [loadSnapshot, t]);

  useEffect(() => {
    // Delegated Codex tasks, while Invoke Mode is on.
    if (!invokeSettings?.invoke_mode) {
      setTasks([]);
      return;
    }
    let disposed = false;
    const load = () => {
      api.invokeTasks().then(
        (loaded) => {
          if (!disposed) {
            setTasks(loaded);
            setTaskClock(Date.now());
          }
        },
        () => undefined,
      );
    };
    load();
    const interval = window.setInterval(load, 2000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [invokeSettings?.invoke_mode]);

  useEffect(() => {
    if (!invokePause) {
      setPausedThreads([]);
      return;
    }
    api.pausedThreads().then(setPausedThreads, () => setPausedThreads([]));
  }, [invokePause]);

  useEffect(() => {
    // Usage is back after a pause: say which threads Claude can continue.
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const unlisten = await api.onInvokeResumed(({ threads }) => {
          setInvokePause(null);
          setNotice({
            kind: "info",
            text: threads.length
              ? t("invoke.resumedThreads", { threads: threads.map((thread) => thread.thread_id).join(", ") })
              : t("invoke.resumedNone"),
          });
        });
        if (disposed) unlisten();
        else stop = unlisten;
      } catch {
        // The pause banner still disappears when the window next reads it.
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [t]);

  // Modified by Light505: a stopped task shows "Stopping…" at once and stays
  // listed until GSwitch reports its worker gone, so it never seems to come back.
  const [stoppingTasks, setStoppingTasks] = useState<ReadonlySet<string>>(() => new Set());
  const stopTask = async (id: string) => {
    setStoppingTasks((current) => new Set(current).add(id));
    try {
      await api.stopInvokeTask(id);
    } catch {
      setStoppingTasks((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setNotice({ kind: "error", text: t("tasks.stopFailed") });
    }
  };

  const resumeInvoke = async () => {
    setInvokeResuming(true);
    try {
      await api.resumeInvoke();
      setInvokePause(null);
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(t, error, t("error.invokeResume")) });
    } finally {
      setInvokeResuming(false);
    }
  };

  const cancelFailover = async () => {
    setFailoverCancelling(true);
    try {
      await api.cancelInvokeFailover();
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(t, error, t("error.invokeCancel")) });
    } finally {
      setFailoverCancelling(false);
    }
  };

  const accountName = (id: string) => {
    const account = accounts.find((saved) => saved.id === id);
    return account ? accountPrimaryName(account) : t("common.unknown");
  };

  const changeAccountInvokeAllowed = async (account: AccountView, allowed: boolean) => {
    try {
      const updated = await api.setAccountInvokeAllowed(account.id, allowed);
      setAccounts((current) => current.map((saved) =>
        saved.id === updated.id ? { ...saved, invoke_allowed: updated.invoke_allowed } : saved,
      ));
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(t, error, t("error.invokeAccount")) });
    }
  };

  // While the window is visible, read each account when its quota can have
  // changed: every check every 30 seconds, and at once when the window
  // regains focus. A hidden window makes no reads.
  useEffect(() => {
    if (loading) return;
    const check = (focused: boolean) => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      setClock(now);
      const { accounts: saved, quotas: readings, quotaFailures: failures, activeId } = refreshInputs.current;
      for (const account of saved) {
        if (account.kind !== "chat_gpt") continue;
        if (quotaRefreshDue(readings[account.id], {
          active: account.active || account.id === activeId,
          focused,
          failure: failures[account.id],
          lastAttemptAt: lastQuotaAttempt.current.get(account.id),
          now,
        })) {
          void requestQuotaRefresh(account.id, true).catch(() => undefined);
        }
      }
    };
    const interval = window.setInterval(() => check(false), 30_000);
    const onFocus = () => check(true);
    const onVisibility = () => {
      if (document.visibilityState === "visible") check(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loading, requestQuotaRefresh]);

  const [updateChecking, setUpdateChecking] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());
  const changeAppearance = (change: Partial<Appearance>) => {
    const next = { ...appearance, ...change };
    saveAppearance(next);
    setAppearance(next);
  };
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null);

  useEffect(() => {
    api.appVersion().then(setAppVersion, () => setAppVersion(null));
  }, []);

  // Modified by Light505: a pending confirmation owns the updater slot until dismissed.
  const checkForUpdateNow = async (rollback = false) => {
    if (updateCheckInFlight.current) return;
    updateCheckInFlight.current = true;
    let offered = false;
    setUpdateChecking(true);
    try {
      const update = await (rollback ? updater.checkRollback() : updater.check());
      if (!update) {
        setNotice({
          kind: "success",
          text: appVersion ? t("update.upToDateVersion", { version: appVersion.version }) : t("update.upToDate"),
        });
        return;
      }
      // Asking again brings back a version dismissed with Later.
      dismissedUpdateVersions.current.delete(update.version);
      const delivery = await api.updateDelivery();
      if (rollback && delivery === "release_download") throw "ROLLBACK_UNAVAILABLE";
      setPendingUpdate({ update, delivery, rollback });
      offered = true;
      setUpdatePhase("available");
      setUpdateProgress(null);
    } catch (error) {
      const key = ({
        UPDATES_DISABLED: "update.error.disabled",
        GITHUB_SIGN_IN_MISSING: "update.error.signIn",
        GITHUB_ACCESS_DENIED: "update.error.access",
        UNTRUSTED_RELEASE: "update.error.untrusted",
        NO_PREVIOUS_RELEASE: "rollback.error.noPrevious",
      } as const)[String(error) as "UPDATES_DISABLED"] ?? (rollback ? "rollback.error.check" : "update.error.check");
      setNotice({ kind: "error", text: t(key) });
    } finally {
      setUpdateChecking(false);
      if (!offered) updateCheckInFlight.current = false;
    }
  };

  const checkForUpdate = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window) || updateCheckInFlight.current) {
      return;
    }
    updateCheckInFlight.current = true;
    let offered = false;
    setUpdateChecking(true);
    try {
      const update = await updater.check();
      if (!update || dismissedUpdateVersions.current.has(update.version)) {
        return;
      }
      const delivery = await api.updateDelivery();
      setPendingUpdate({ update, delivery });
      offered = true;
      setUpdatePhase("available");
      setUpdateProgress(null);
    } catch {
      // A failed background check is intentionally quiet. A user-initiated
      // install reports an actionable retry state instead.
    } finally {
      setUpdateChecking(false);
      if (!offered) updateCheckInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void checkForUpdate();
    const interval = window.setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

  const runTask = useCallback(
    async <T,>(key: string, task: () => Promise<T>, reload = true): Promise<T | undefined> => {
      setBusy(key);
      try {
        const result = await task();
        if (reload) {
          await loadSnapshot();
        }
        return result;
      } catch (error) {
        setNotice({ kind: "error", text: friendlyError(t, error) });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [loadSnapshot, t],
  );

  const runVoidTask = useCallback(
    async (key: string, task: () => Promise<void>, reload = true): Promise<boolean> => {
      setBusy(key);
      try {
        await task();
        if (reload) {
          await loadSnapshot();
        }
        return true;
      } catch (error) {
        setNotice({ kind: "error", text: friendlyError(t, error) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [loadSnapshot, t],
  );

  const runAccountTask = useCallback(
    async <T,>(accountId: string, action: Exclude<AccountBusyAction, "switch">, task: () => Promise<T>): Promise<T | undefined> => {
      if (accountOperations.current.has(accountId)) {
        return undefined;
      }

      accountOperations.current.add(accountId);
      setAccountBusy((current) => ({ ...current, [accountId]: action }));
      try {
        return await task();
      } catch (error) {
        setNotice({ kind: "error", text: friendlyError(t, error) });
        return undefined;
      } finally {
        accountOperations.current.delete(accountId);
        setAccountBusy((current) => {
          const remaining = { ...current };
          delete remaining[accountId];
          return remaining;
        });
      }
    },
    [t],
  );

  const importPaths = useCallback(
    async (paths: string[]) => {
      const result = await runTask("import", () => api.importAuthFiles(paths));
      if (result) {
        const skippedCount = result.unsupported_count + result.failed_count;
        setNotice({
          kind: result.imported.length ? "success" : "info",
          text: t("notice.importBatch", {
            imported: formatNumber(result.imported.length, locale.formatLocale),
            duplicates: formatNumber(result.duplicate_count, locale.formatLocale),
            skipped: formatNumber(skippedCount, locale.formatLocale),
          }),
        });
        setDialog(null);
      }
    },
    [locale.formatLocale, runTask, t],
  );

  const chooseImportFile = useCallback(async () => {
    try {
      const selected = await open({
        title: t("add.fileTitle"),
        filters: fileFilters(t),
        multiple: true,
      });
      if (selected?.length) {
        await importPaths(selected);
      }
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(t, error, t("error.filePicker")) });
    }
  }, [importPaths, t]);

  const scanMigration = useCallback(
    async (customRoot?: string) => {
      const result = await runTask(
        "migration-scan",
        () => api.discoverLocalAccounts(customRoot),
        false,
      );
      if (result) {
        setMigrationRoot(customRoot);
        setMigrationPreview(result);
        setMigrationScanned(true);
        setMigrationSelection(
          result.candidates
            .filter((candidate) => candidate.state === "new")
            .map((candidate) => candidate.id),
        );
      }
    },
    [runTask],
  );

  const chooseMigrationFolder = useCallback(async () => {
    try {
      const selected = await open({
        title: t("migration.chooseFolder"),
        directory: true,
        multiple: false,
      });
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (selectedPath) {
        await scanMigration(selectedPath);
      }
    } catch (error) {
      setNotice({ kind: "error", text: friendlyError(t, error, t("error.migrationFolder")) });
    }
  }, [scanMigration, t]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }
        const paths = event.payload.paths;
        if (paths.length) {
          void importPaths(paths);
        }
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        // File selection remains available if drag-and-drop cannot register.
      });
    return () => unlisten?.();
  }, [importPaths]);

  useEffect(() => {
    if (!oauth || (oauth.status.status !== "pending" && oauth.status.status !== "finishing")) {
      return;
    }
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await api.oauthStatus(oauth.login_id);
        if (closed) {
          return;
        }
        setOauthStatusUnavailable(false);
        setOauth((current) =>
          current?.login_id === oauth.login_id ? { ...current, status } : current,
        );
        if (status.status === "complete") {
          if (oauthTarget) {
            setAccountSignInNeeded((current) => ({ ...current, [oauthTarget.id]: false }));
          }
          void requestQuotaRefresh(status.account.id, true).catch(() => undefined);
          if (!status.account.needs_apply) {
            setNotice({ kind: "success", text: t(oauthTarget ? "notice.reauthenticatedAccount" : "notice.importedAccount", { name: accountPrimaryName(status.account) }) });
          }
          void loadSnapshot();
        } else if (status.status === "pending" || status.status === "finishing") {
          timer = window.setTimeout(poll, 800);
        }
      } catch {
        if (!closed) {
          setOauthStatusUnavailable(true);
          timer = window.setTimeout(poll, 2500);
        }
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      closed = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [loadSnapshot, oauth, oauthTarget, requestQuotaRefresh, t]);

  useEffect(() => {
    if (!wake || wake.status !== "running") {
      return;
    }
    let closed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.wakeOperation(wake.id);
        if (closed) {
          return;
        }
        setWakeStatusUnavailable(false);
        setWake(next);
        if (next.status === "running") {
          timer = window.setTimeout(poll, 850);
        } else {
          void loadSnapshot();
          for (const result of next.results) {
            void requestQuotaRefresh(result.account_id, true).catch(() => undefined);
          }
        }
      } catch {
        if (!closed) {
          setWakeStatusUnavailable(true);
          timer = window.setTimeout(poll, 2500);
        }
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => {
      closed = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [loadSnapshot, requestQuotaRefresh, t, wake]);

  const startOAuth = async (target?: AccountView) => {
    const result = await runTask("oauth", () => api.startOAuth(target?.id), false);
    if (!result) {
      return;
    }
    setOauth({ ...result, status: { status: "pending" } });
    setOauthStatusUnavailable(false);
    setOauthTarget(target ?? null);
    setDialog("add");
    setAddMethod("oauth");
  };

  const dismissUpdate = () => {
    if (pendingUpdate && !pendingUpdate.rollback) {
      dismissedUpdateVersions.current.add(pendingUpdate.update.version);
    }
    setPendingUpdate(null);
    updateCheckInFlight.current = false;
    setUpdatePhase("available");
    setUpdateProgress(null);
  };

  const installUpdate = async () => {
    if (!pendingUpdate) {
      return;
    }
    if (pendingUpdate.delivery === "release_download") {
      try {
        await api.openLatestRelease();
      } catch {
        setUpdatePhase("error");
      }
      return;
    }

    setUpdatePhase("downloading");
    setUpdateProgress(null);
    let expectedBytes: number | undefined;
    let downloadedBytes = 0;
    try {
      await pendingUpdate.update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          expectedBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (expectedBytes && expectedBytes > 0) {
            setUpdateProgress(Math.min(100, Math.round((downloadedBytes / expectedBytes) * 100)));
          }
        }
      });
      setUpdatePhase(pendingUpdate.delivery === "installer_exits" ? "installing" : "ready");
    } catch (error) {
      if (error === "INVOKE_BUSY") {
        // Restarting would stop Claude's delegated Codex work; offer it again later.
        setUpdatePhase("available");
        setUpdateProgress(null);
        setNotice({ kind: "info", text: t("update.invokeBusy") });
        return;
      }
      setUpdatePhase("error");
    }
  };

  const restartAfterUpdate = async () => {
    try {
      await updater.relaunch();
    } catch {
      setUpdatePhase("error");
    }
  };

  const cancelOAuth = async () => {
    if (!oauth) {
      return;
    }
    await runVoidTask("oauth-cancel", () => api.cancelOAuth(oauth.login_id), false);
  };

  const retryOAuthSave = async () => {
    if (!oauth) return;
    const completed = await runVoidTask("oauth-retry", () => api.retryOAuth(oauth.login_id), false);
    if (completed) setOauth((current) => current ? { ...current, status: { status: "finishing" } } : current);
  };

  const closeAddDialog = () => {
    if (oauth?.status.status === "pending") {
      void api.cancelOAuth(oauth.login_id);
    }
    setDialog(null);
  };

  const openAddDialog = (method: AddMethod = "start") => {
    setOauth(null);
    setOauthStatusUnavailable(false);
    setOauthTarget(null);
    setAddMethod(method);
    setMigrationPreview(null);
    setMigrationRoot(undefined);
    setMigrationSelection([]);
    setMigrationScanned(false);
    setDialog("add");
  };

  const confirmMigration = async () => {
    if (!migrationSelection.length) {
      return;
    }
    const result = await runTask(
      "migration-import",
      () => api.importLocalAccounts(migrationRoot, migrationSelection),
    );
    if (result) {
      const skippedCount = result.unsupported_count + result.failed_count;
      setNotice({
        kind: result.imported.length ? "success" : "info",
        text: t("notice.migration", {
          imported: formatNumber(result.imported.length, locale.formatLocale),
          duplicates: formatNumber(result.duplicate_count, locale.formatLocale),
          skipped: formatNumber(skippedCount, locale.formatLocale),
        }),
      });
      setMigrationPreview(null);
      setMigrationSelection([]);
      setMigrationRoot(undefined);
      setMigrationScanned(false);
      setDialog(null);
    }
  };

  const copyOAuthUrl = async () => {
    if (!oauth) {
      return;
    }
    try {
      await navigator.clipboard.writeText(oauth.auth_url);
      setNotice({ kind: "success", text: t("notice.oauthCopied") });
    } catch {
      setNotice({ kind: "info", text: t("notice.copyManually") });
    }
  };

  const copyAccountEmail = async (account: AccountView) => {
    if (!account.email) return;
    try {
      await navigator.clipboard.writeText(account.email);
      setNotice({ kind: "success", text: t("notice.emailCopied") });
    } catch {
      setNotice({ kind: "error", text: t("notice.emailCopyFailed") });
    }
  };

  const submitJson = async (event: FormEvent) => {
    event.preventDefault();
    const rawJson = jsonRef.current?.value ?? "";
    if (jsonRef.current) {
      jsonRef.current.value = "";
    }
    if (!rawJson.trim()) {
      setNotice({ kind: "error", text: t("notice.pasteAuth") });
      return;
    }
    const result = await runTask("import-json", () => api.importAuthJson(rawJson, label || undefined));
    if (result) {
      setLabel("");
      setDialog(null);
      setNotice({ kind: "success", text: t("notice.importedAccount", { name: accountPrimaryName(result) }) });
    }
  };

  const submitApiKey = async (event: FormEvent) => {
    event.preventDefault();
    const apiKey = apiKeyRef.current?.value ?? "";
    if (apiKeyRef.current) {
      apiKeyRef.current.value = "";
    }
    if (!apiKey.trim()) {
      setNotice({ kind: "error", text: t("notice.enterApiKey") });
      return;
    }
    const result = await runTask("import-key", () => api.importApiKey(apiKey, label || undefined));
    if (result) {
      setLabel("");
      setDialog(null);
      setNotice({ kind: "success", text: t("notice.savedApiKey", { name: result.label }) });
    }
  };

  // A full refresh shows progress on the toolbar and each card; it does not
  // lock the rest of the workspace.
  const refreshAll = async () => {
    const targets = accounts.filter((account) => account.kind === "chat_gpt");
    if (!targets.length || refreshProgress) {
      return;
    }
    setRefreshProgress({ done: 0, total: targets.length });
    const results = await Promise.allSettled(
      targets.map((account) =>
        requestQuotaRefresh(account.id).finally(() =>
          setRefreshProgress((current) => current && { ...current, done: current.done + 1 }),
        ),
      ),
    );
    setRefreshProgress(null);
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures) {
      setNotice({
        kind: "info",
        text: t("notice.quotaUnavailable", {
          count: formatNumber(failures, locale.formatLocale),
        }),
      });
    }
  };

  const switchAccount = async (account: AccountView) => {
    setBusy("switch:" + account.id);
    try {
      const outcome = await api.switchAccount(account.id);
      setAccountSignInNeeded((current) => ({ ...current, [account.id]: false }));
      setAccounts((current) => current.map((saved) =>
        saved.id === outcome.account.id
          ? { ...outcome.account, active: true }
          : { ...saved, active: false },
      ).sort((left, right) => Number(right.active) - Number(left.active)));
      setLive({ status: "ready", credential_store: "file", account: outcome.account });
      setNotice(null);
      void requestQuotaRefresh(outcome.account.id, true).catch(() => undefined);
    } catch (error) {
      if (asSwitchFailure(error)?.code === "account_needs_sign_in") {
        setAccountSignInNeeded((current) => ({ ...current, [account.id]: true }));
      }
      setNotice({ kind: "error", text: switchFailureMessage(t, error, account) });
    } finally {
      setBusy(null);
    }
  };

  // The card itself shows the refreshed quota; only failures need a notice.
  const refreshAccount = async (account: AccountView) => {
    await runAccountTask(account.id, "refresh", () => requestQuotaRefresh(account.id));
  };

  const startWake = async (accountId?: string, alternateModel = false) => {
    const result = accountId
      ? await runAccountTask(accountId, "wake", () => api.startWake(accountId, alternateModel))
      : await runTask("wake-all", api.startWakeAll, false);
    if (result) {
      setWake({ id: result.operation_id, status: "running", alternate_model: alternateModel, results: [] });
      setWakeStatusUnavailable(false);
      setDialog("wake");
    }
  };

  const startSelectedWake = async () => {
    const selectedChatGptIds = accounts
      .filter((account) => account.kind === "chat_gpt" && selectedAccountIds.includes(account.id))
      .map((account) => account.id);
    const result = await runTask(
      "wake-selected",
      () => api.startWakeSelected(selectedChatGptIds),
      false,
    );
    if (result) {
      setWake({ id: result.operation_id, status: "running", alternate_model: false, results: [] });
      setWakeStatusUnavailable(false);
      setDialog("wake");
    }
  };

  const exportSelectedAccounts = async () => {
    const result = await runTask(
      "export-accounts",
      () => api.exportAccounts(selectedAccountIds),
      false,
    );
    if (result) {
      confirm.disarm();
      setDialog(null);
      if (!result.cancelled) {
        setNotice({
          kind: "success",
          text: t("notice.exported", {
            count: formatNumber(result.exported_count, locale.formatLocale),
          }),
        });
      }
    }
  };

  // Rust returns the quota it read after a confirmed reset; show it at once
  // instead of waiting for the card's next refresh.
  const showResetQuota = (quota: QuotaView | undefined) => {
    if (!quota) {
      return;
    }
    setQuotas((current) => ({ ...current, [quota.account_id]: quota }));
    setQuotaFailures((current) => {
      const next = { ...current };
      delete next[quota.account_id];
      return next;
    });
  };

  // Each outcome says whether a credit was used, and which one.
  const resetOutcomeNotice = (result: ResetCreditOutcome): Notice => {
    const account = accounts.find((saved) => saved.id === result.account_id);
    const name = account ? accountPrimaryName(account) : t("recovery.removedAccount");
    switch (result.outcome) {
      case "reset":
        if (result.refresh_warning) {
          return { kind: "success", text: t("notice.resetRefreshWarning") };
        }
        return {
          kind: "success",
          text: result.used_expires_at
            ? t("notice.resetUsed", { name, date: formatDateTime(result.used_expires_at, locale.formatLocale) })
            : t("notice.resetUsedUndated", { name }),
        };
      case "already_redeemed":
        return {
          kind: "success",
          text: result.refresh_warning ? t("notice.resetRefreshWarning") : t("notice.resetAlreadyApplied"),
        };
      case "nothing_to_reset":
        return { kind: "info", text: t("notice.resetNotNeeded", { name }) };
      case "no_credit":
        return { kind: "info", text: t("notice.resetNoCredit", { name }) };
    }
  };

  // Redeems the credit on the row the user confirmed. Rust matches it again
  // against a fresh provider read before consuming anything.
  const redeemReset = async (credit: ResetCreditDetail, pick: string) => {
    if (!resetAccount) {
      return;
    }
    setRedeemingCredit(pick);
    const result = await runTask(
      "reset:" + resetAccount.id,
      () => api.redeemResetCredit(resetAccount.id, credit),
    );
    setRedeemingCredit(null);
    if (!result) {
      // A failed request may have left a pending record that needs recovery.
      void loadSnapshot();
      return;
    }
    showResetQuota(result.quota);
    setNotice(resetOutcomeNotice(result));
    setResetAccount(null);
    setDialog(null);
  };

  const recoverPendingResetCredit = async () => {
    const result = await runTask("recover-reset-credit", api.recoverPendingResetCredit);
    if (!result) {
      void loadSnapshot();
      return;
    }
    showResetQuota(result.quota);
    setNotice(resetOutcomeNotice(result));
    setDialog(null);
  };

  // Rust offers a discard only when retrying can no longer consume the
  // recorded credit; the second click confirms.
  const discardPendingReset = async () => {
    if (!discardConfirmation) {
      setDiscardConfirmation(true);
      return;
    }
    const completed = await runVoidTask("discard-reset-credit", api.discardPendingResetCredit);
    setDiscardConfirmation(false);
    if (completed) {
      setDialog(null);
      setNotice({ kind: "success", text: t("notice.resetDiscarded") });
    }
  };

  const removeSavedAccount = async () => {
    if (!removeAccount) {
      return;
    }
    setRemoveError(null);
    setBusy("remove:" + removeAccount.id);
    try {
      await api.removeSavedAccount(removeAccount.id);
      await loadSnapshot();
      setNotice({ kind: "success", text: t("notice.removed", { name: accountPrimaryName(removeAccount) }) });
      setRemoveAccount(null);
      setDialog(null);
    } catch (error) {
      setRemoveError(removeFailureMessage(t, error));
    } finally {
      setBusy(null);
    }
  };

  const resetDamagedAccountStore = async () => {
    const completed = await runVoidTask(
      "reset-damaged-store",
      api.resetDamagedAccountStore,
    );
    if (completed) {
      confirm.disarm();
      setDialog(null);
      setNotice({
        kind: "success",
        text: t("notice.storageReset"),
      });
    }
  };

  const cliUpdateAvailable = cliInfo?.update_status === "available" && cliInfo.supports_update;
  const currentActiveId = live?.account?.id;
  refreshInputs.current = { accounts, quotas, quotaFailures, activeId: currentActiveId };
  const chatGptAccounts = accounts.filter((account) => account.kind === "chat_gpt");
  const orderList = orderedAccounts(chatGptAccounts, orderDraft ?? invokeSettings?.account_priority ?? []);
  const reserveValues = reserveDraft
    ?? Object.fromEntries(Object.entries(invokeSettings?.weekly_reserve ?? {}).map(([id, percent]) => [id, String(percent)]));
  const moveInOrder = (index: number, offset: number) => {
    const next = orderList.map((account) => account.id);
    const [id] = next.splice(index, 1);
    next.splice(index + offset, 0, id);
    setOrderDraft(next);
  };
  const saveOrder = async () => {
    if (!invokeSettings) return;
    setOrderSaving(true);
    setOrderError(null);
    try {
      await api.setInvokePreferences(
        orderList.map((account) => account.id),
        invokeSettings.preferred_min_remaining ?? 20,
        invokeSettings.max_concurrent_tasks ?? 2,
        invokeSettings.auto_wake ?? false,
      );
      const saved = await api.setInvokeWeeklyReserve(Object.fromEntries(
        Object.entries(reserveValues)
          .map(([id, percent]) => [id, clampPercent(percent, 0, 90, 0)] as const)
          .filter(([, percent]) => percent > 0),
      ));
      setInvokeSettings(saved);
      setOrderDraft(null);
      setReserveDraft(null);
      setNotice({ kind: "success", text: t("invoke.saved") });
    } catch {
      setOrderError(t("error.invokeSave"));
    } finally {
      setOrderSaving(false);
    }
  };
  const selectedChatGptCount = accounts.filter(
    (account) => account.kind === "chat_gpt" && selectedAccountIds.includes(account.id),
  ).length;
  const resetCredits = resetAccount ? quotas[resetAccount.id]?.snapshot?.reset_credits : undefined;
  const resetDialogName = (account: AccountView) => {
    const name = accountPrimaryName(account);
    const sameEmail = account.email
      ? accounts.filter((saved) => saved.email === account.email).length
      : 1;
    return sameEmail > 1 && account.workspace_name ? `${name} · ${account.workspace_name}` : name;
  };
  const pendingResetAccount = pendingReset
    ? accounts.find((account) => account.id === pendingReset.account_id)
    : undefined;
  const storageRecovery = storage?.status === "recovery_required";
  const accountGridBusy = accountGridHasGlobalMutation(busy);
  // A dialog stays closable while unrelated work runs; only its own operation
  // holds it open. A key ending in ":" matches that operation for any account.
  const runningAny = (...keys: string[]) =>
    busy !== null && keys.some((key) => (key.endsWith(":") ? busy.startsWith(key) : busy === key));

  const safetyNotice = useMemo(() => {
    if (storage?.status === "recovery_required") {
      return {
        icon: <ShieldAlert size={20} />,
        title: t("safety.storageTitle"),
        body: t("safety.storageBody"),
        action: t("safety.reviewRecovery"),
        onAction: () => {
          confirm.disarm();
          setDialog("storage-recovery");
        },
      };
    }
    if (pendingResetCredit) {
      return {
        icon: <CircleAlert size={20} />,
        title: t("safety.resetTitle"),
        body: t("safety.resetBody"),
        action: t("safety.reviewReset"),
        onAction: () => setDialog("recover-reset-credit"),
      };
    }
    if (!live) {
      return null;
    }
    if (live.status === "unknown_account") {
      return {
        icon: <ShieldAlert size={20} />,
        title: t("safety.currentTitle"),
        body: t("safety.currentBody"),
        action: t("safety.saveCurrent"),
        onAction: () =>
          void runTask("save-current", api.saveCurrentAccount).then((account) => {
            if (account) {
              setNotice({ kind: "success", text: t("notice.savedCurrent", { name: accountPrimaryName(account) }) });
            }
          }),
      };
    }
    if (live.status === "file_store_required") {
      return {
        icon: <ShieldAlert size={20} />,
        title: t("safety.fileTitle"),
        body: t("safety.fileBody"),
        action: t("safety.enable"),
        onAction: () => setDialog("enable-switching"),
      };
    }
    if (live.status === "recovery_required") {
      return {
        icon: <CircleAlert size={20} />,
        title: t("safety.switchTitle"),
        body: t("safety.switchBody"),
        action: t("safety.reviewRecovery"),
        onAction: () => setDialog("recover-switch"),
      };
    }
    return null;
  }, [live, pendingResetCredit, runTask, storage, t]);

  const setupSentence = describeSetup(invokeSettings, accounts);
  const pluginVersions = claudePlugins
    ? [
      claudePlugins.codex.installed ? t("plugins.codexVersion", { version: claudePlugins.codex.version ?? "?" }) : null,
      claudePlugins.router.installed ? t("plugins.routerVersion", { version: claudePlugins.router.version ?? "?" }) : null,
    ].filter(Boolean).join(" · ")
    : "";
  const showHistoryLog = (threadId: string, threads: string[]) => {
    setHistoryThreads([...new Set(threads)]);
    watchLog({ id: threadId, threadId, title: t("log.historyTitle", { thread: shortThread(threadId) }) });
  };
  const navItems = {
    home: { icon: <House aria-hidden="true" size={17} />, label: t("nav.home") },
    accounts: { icon: <Users aria-hidden="true" size={17} />, label: t("nav.accounts") },
    "claude-code": { icon: <Bot aria-hidden="true" size={17} />, label: t("nav.claudeCode") },
    results: { icon: <History aria-hidden="true" size={17} />, label: t("nav.results") },
    settings: { icon: <Settings aria-hidden="true" size={17} />, label: t("nav.settings") },
  } satisfies Record<Section, { icon: ReactNode; label: string }>;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header className="brand-lockup">
          <img alt="" aria-hidden="true" className="brand-mark" src="/gswitch-icon.svg" />
          <div className="brand-copy">
            <h1>GSwitch Claude Tool</h1>
            {appVersion ? (
              <span className="brand-version" title={t(appVersion.dev ? "app.devVersion" : "app.version", { version: appVersion.version })}>
                v{appVersion.version}{appVersion.dev ? " · dev" : ""}
              </span>
            ) : null}
          </div>
        </header>
        <nav aria-label={t("nav.label")} className="sidebar-nav">
          <ul>
            {SECTIONS.map((item) => (
              <li key={item}>
                <button
                  aria-current={section === item ? "page" : undefined}
                  className="nav-item"
                  onClick={() => {
                    if (item !== section) focusPageHeading.current = true;
                    if (item === "settings") openSettings();
                    else selectSection(item);
                  }}
                  type="button"
                >
                  {navItems[item].icon}
                  <span className="nav-label">{navItems[item].label}</span>
                  {item === "accounts" && !loading ? <>{" "}<span className="nav-badge">{formatNumber(accounts.length, locale.formatLocale)}</span></> : null}
                  {item === "settings" && cliInfo?.update_status === "available" ? (
                    <>{" "}<span
                      aria-label={t("cli.available", { version: cliInfo.latest_version || "" })}
                      className="nav-dot"
                      role="img"
                      title={t("cli.available", { version: cliInfo.latest_version || "" })}
                    /></>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="content">
        {pendingUpdate ? (
          <UpdateNotice
            onInstall={() => void installUpdate()}
            onLater={dismissUpdate}
            onRestart={() => void restartAfterUpdate()}
            pending={pendingUpdate}
            phase={updatePhase}
            progress={updateProgress}
            t={t}
          />
        ) : null}

        {notice ? (
          <div className={"toast toast-" + notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.kind === "success" ? <CircleCheck size={17} /> : <CircleAlert size={17} />}
            <span>{notice.text}</span>
            <button aria-label={t("common.dismissMessage")} onClick={() => setNotice(null)} type="button"><X size={15} /></button>
          </div>
        ) : null}

        {failoverWaiting ? (
          <section className="safety-notice" role="alert">
            <div className="safety-icon"><ShieldAlert size={20} /></div>
            <div>
              <h2>{t("invoke.closeCodexTitle")}</h2>
              <p>{t("invoke.closeCodexBody", { from: accountName(failoverWaiting.from), to: accountName(failoverWaiting.to) })}</p>
            </div>
            <button className="button button-secondary" disabled={failoverCancelling} onClick={() => void cancelFailover()} type="button">
              {t("invoke.cancelSwitch")}
            </button>
          </section>
        ) : null}

        {invokePause && !failoverWaiting ? (
          <section className="safety-notice" role="status">
            <div className="safety-icon"><CircleAlert size={20} /></div>
            <div>
              <h2>{t("invoke.pausedTitle")}</h2>
              <p>
                {invokePause.resumes_at == null
                  ? t("invoke.pausedBodyUnknown")
                  : t("invoke.pausedBody", { time: formatDateTimeWithRelative(invokePause.resumes_at, locale.formatLocale) })}
              </p>
              {pausedThreads.length ? (
                <p className="paused-threads">
                  {t("invoke.pausedThreads", { threads: pausedThreads.map((thread) => thread.thread_id).join(", ") })}
                </p>
              ) : null}
            </div>
            <button className="button button-secondary" disabled={invokeResuming} onClick={() => void resumeInvoke()} type="button">
              {t("invoke.resume")}
            </button>
          </section>
        ) : null}

        {safetyNotice ? (
          <section className="safety-notice">
            <div className="safety-icon">{safetyNotice.icon}</div>
            <div>
              <h2>{safetyNotice.title}</h2>
              <p>{safetyNotice.body}</p>
            </div>
            <button className="button button-secondary" disabled={busy !== null} onClick={safetyNotice.onAction} type="button">
              {safetyNotice.action}
            </button>
          </section>
        ) : null}

        {!safetyNotice && live?.status === "not_signed_in" && accounts.length > 0 ? (
          <p className="signed-out-notice" role="status">{t("safety.signedOut")}</p>
        ) : null}

        {section === null ? (
          <div className="loading-state"><LoaderCircle className="spin" size={24} />{t("accounts.reading")}</div>
        ) : null}

        {section === "home" ? (
          <div className="page">
            <h2 className="page-title" tabIndex={-1}>{t("nav.home")}</h2>
            {(() => {
              if (getStartedHidden || !invokeSettings) return null;
              const needsRouter = invokeSettings.claude_setup.setup === "router";
              const stepDone = [
                chatGptAccounts.length > 0,
                claudeVisited || invokeSettings.claude_setup.setup !== "claude-only",
                Boolean(claudePlugins?.codex.installed && (!needsRouter || claudePlugins.router.installed)),
              ];
              if (stepDone.every(Boolean)) return null;
              const mark = (done: boolean) => (
                <span aria-label={t(done ? "getStarted.done" : "getStarted.todo")} className={"get-started-mark" + (done ? " get-started-done" : "")} role="img">
                  {done ? <Check size={14} /> : null}
                </span>
              );
              return (
                <section aria-labelledby="home-start-heading" className="page-card get-started">
                  <div className="get-started-head">
                    <h3 id="home-start-heading">{t("getStarted.title")}</h3>
                    <button className="back-link" onClick={() => { saveFlag(GET_STARTED_HIDDEN_KEY); setGetStartedHidden(true); }} type="button">
                      {t("getStarted.hide")}
                    </button>
                  </div>
                  <ol className="get-started-steps">
                    <li>
                      {mark(stepDone[0])}
                      <div>
                        <strong>{t("getStarted.accounts")}</strong>
                        {stepDone[0] ? null : (
                          <button className="button button-secondary" onClick={() => { selectSection("accounts"); openAddDialog(); }} type="button">
                            {t("getStarted.addAccount")}
                          </button>
                        )}
                      </div>
                    </li>
                    <li>
                      {mark(stepDone[1])}
                      <div>
                        <strong>{t("getStarted.setup")}</strong>
                        {stepDone[1] ? null : (
                          <button className="button button-secondary" onClick={() => selectSection("claude-code")} type="button">
                            {t("getStarted.choose")}
                          </button>
                        )}
                      </div>
                    </li>
                    <li>
                      {mark(stepDone[2])}
                      <div>
                        <strong>{t("getStarted.plugins")}</strong>
                        {stepDone[2]
                          ? <p className="home-empty">{pluginVersions}</p>
                          : <PluginCommands router={needsRouter} t={t} />}
                      </div>
                    </li>
                  </ol>
                </section>
              );
            })()}
            {setupSentence ? (
              <section aria-labelledby="home-setup-heading" className="page-card home-setup">
                <div>
                  <h3 id="home-setup-heading">{t("home.setupTitle")}</h3>
                  <p>{setupSentence}</p>
                </div>
                <button className="button button-secondary" onClick={() => selectSection("claude-code")} type="button">
                  {t("home.change")}
                </button>
              </section>
            ) : null}
            <section aria-labelledby="home-running-heading" className="task-strip">
              <h3 id="home-running-heading">{t("home.runningTitle")}</h3>
              {tasks.length ? (
                <ul aria-label={t("tasks.title")}>
                  {tasks.map((task) => {
                    const folder = folderName(task.cwd);
                    const armed = confirm.armed === `task-${task.id}`;
                    const stopping = Boolean(task.stopping) || stoppingTasks.has(task.id);
                    return (
                      <li key={task.id}>
                        <span className={"task-state" + (stopping ? " task-stopping" : task.running ? " task-running" : "")}>{t(stopping ? "tasks.stopping" : task.running ? "tasks.running" : "tasks.waiting")}</span>
                        <strong>{task.model}</strong>
                        <span className="badge">{task.reasoning_effort}</span>
                        {task.write ? <span className="badge">{t("tasks.write")}</span> : null}
                        <span className="task-folder" title={task.cwd}>{folder}</span>
                        {task.thread_id ? <span className="task-thread" title={task.thread_id}>{t("tasks.thread", { thread: shortThread(task.thread_id) })}</span> : null}
                        <span className="task-elapsed">{elapsedText(taskClock - task.started_at)}</span>
                        <button
                          aria-label={t("tasks.watchFor", { model: task.model, folder })}
                          className="button button-secondary"
                          onClick={() => watchLog({
                            id: task.id,
                            taskId: task.id,
                            threadId: task.thread_id ?? null,
                            title: t("log.title", { model: task.model, folder }),
                          })}
                          type="button"
                        >
                          <Terminal size={13} />
                          {t("tasks.watch")}
                        </button>
                        <button
                          aria-label={stopping ? t("tasks.stopping") : armed ? t("tasks.confirmStop") : t("tasks.stopFor", { model: task.model, folder })}
                          className={"button " + (armed && !stopping ? "button-danger" : "button-secondary")}
                          data-confirm={`task-${task.id}`}
                          disabled={stopping}
                          onClick={() => confirm.click(`task-${task.id}`, () => void stopTask(task.id))}
                          type="button"
                        >
                          {stopping ? <LoaderCircle className="spin" size={13} /> : <Square size={13} />}
                          {stopping ? t("tasks.stopping") : armed ? t("tasks.confirmStop") : t("tasks.stop")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="home-empty">{t("home.nothingRunning")}</p>}
            </section>
            <section aria-labelledby="home-recent-heading" className="page-card home-recent">
              <h3 id="home-recent-heading">{t("home.recentTitle")}</h3>
              <RecentActivity formatLocale={locale.formatLocale} name={accountName} onSeeAll={() => selectSection("results")}
                onViewLog={showHistoryLog} t={t} />
            </section>
          </div>
        ) : null}

        {section === "claude-code" || claudeCodeOpened ? (
          <div className="page" hidden={section !== "claude-code"}>
            {invokeSettings && !loading && !storageRecovery ? (
              <>
                <section aria-labelledby="claude-setup-heading" className="page-section">
                  <h2 className="page-title" id="claude-setup-heading" tabIndex={-1}>{t("claudeSetup.title")}</h2>
                  <ClaudeSetupPanel
                    onSaved={(saved) => {
                      setInvokeSettings(saved);
                      setInvokePause(null);
                      setNotice({ kind: "success", text: t("claudeSetup.saved") });
                    }}
                    accounts={chatGptAccounts}
                    onSaveFailed={reportSaveFailure}
                    settings={invokeSettings}
                    t={t}
                  />
                </section>
                <section aria-labelledby="codex-helper-heading" className="page-card">
                  <h3 className="page-card-title" id="codex-helper-heading">{t("claudeCode.codexHelper")}</h3>
                  <InvokeSettingsPanel
                    accounts={chatGptAccounts}
                    onSaved={(saved) => {
                      setInvokeSettings(saved);
                      setNotice({ kind: "success", text: t("invoke.saved") });
                    }}
                    onSaveFailed={reportSaveFailure}
                    onOpenAccounts={() => selectSection("accounts")}
                    settings={invokeSettings}
                    t={t}
                  />
                </section>
              </>
            ) : (
              <>
                <h2 className="page-title" tabIndex={-1}>{t("claudeSetup.title")}</h2>
                {storageRecovery ? <p className="home-empty">{t("accounts.recoveryDescription")}</p>
                  : invokeSettingsFailed ? <p className="remove-error" role="alert">{t("claudeCode.unavailable")}</p>
                  : <div className="loading-state"><LoaderCircle className="spin" size={24} />{t("claudeCode.loading")}</div>}
              </>
            )}
          </div>
        ) : null}

        {section === "results" ? (
          <section aria-labelledby="results-heading" className="page">
            <h2 className="page-title" id="results-heading" tabIndex={-1}>{t("results.title")}</h2>
            <ModelResults t={t} />
            <section aria-labelledby="activity-heading">
              <h3 className="page-card-title results-activity-title" id="activity-heading">{t("activity.title")}</h3>
              <ActivityPanel formatLocale={locale.formatLocale} name={accountName} onViewLog={showHistoryLog} t={t} />
            </section>
          </section>
        ) : null}

        {section === "settings" ? (
          <div className="page">
            <h2 className="page-title" tabIndex={-1}>{t("nav.settings")}</h2>
            <section aria-labelledby="settings-appearance-heading" className="page-card settings-card">
              <h3 className="page-card-title" id="settings-appearance-heading">{t("toolbar.appearance")}</h3>
              <div aria-label={t("appearance.palette")} className="settings-choices" role="group">
                <span className="settings-label">{t("appearance.palette")}</span>
                {PALETTES.map((palette) => (
                  <button
                    aria-pressed={appearance.palette === palette}
                    className="settings-choice"
                    key={palette}
                    onClick={() => changeAppearance({ palette })}
                    type="button"
                  >
                    <span aria-hidden="true" className="appearance-swatch">
                      {PALETTE_SWATCHES[palette].map((color) => <i key={color} style={{ background: color }} />)}
                    </span>
                    {t(`palette.${palette}`)}
                    {appearance.palette === palette ? <Check size={15} /> : null}
                  </button>
                ))}
              </div>
              <div aria-label={t("appearance.mode")} className="settings-choices" role="group">
                <span className="settings-label">{t("appearance.mode")}</span>
                {SCHEMES.map((scheme) => (
                  <button
                    aria-pressed={appearance.scheme === scheme}
                    className="settings-choice"
                    key={scheme}
                    onClick={() => changeAppearance({ scheme })}
                    type="button"
                  >
                    {t(`scheme.${scheme}`)}
                    {appearance.scheme === scheme ? <Check size={15} /> : null}
                  </button>
                ))}
              </div>
            </section>
            <section aria-labelledby="settings-updates-heading" className="page-card settings-card">
              <h3 className="page-card-title" id="settings-updates-heading">{t("settingsPage.updates")}</h3>
              {appVersion ? <p className="home-empty">{t(appVersion.dev ? "app.devVersion" : "app.version", { version: appVersion.version })}</p> : null}
              <div className="settings-actions">
                <button
                  className="button button-secondary"
                  disabled={updateChecking || pendingUpdate !== null}
                  onClick={() => void checkForUpdateNow()}
                  type="button"
                >
                  {updateChecking ? <LoaderCircle className="spin" size={15} /> : <CircleArrowUp size={15} />}
                  {t("update.check")}
                </button>
                <button
                  className="button button-quiet"
                  disabled={updateChecking || pendingUpdate !== null}
                  onClick={() => void checkForUpdateNow(true)}
                  type="button"
                >
                  <CircleArrowDown size={15} />
                  {t("rollback.check")}
                </button>
              </div>
            </section>
            <section aria-labelledby="settings-plugins-heading" className="page-card settings-card">
              <h3 className="page-card-title" id="settings-plugins-heading">{t("plugins.title")}</h3>
              <ul className="plugin-status">
                <li>{claudePlugins?.codex.installed
                  ? t("plugins.codexVersion", { version: claudePlugins.codex.version ?? "?" })
                  : `${t("plugins.codexName")}: ${t("plugins.notInstalled")}`}</li>
                <li>{claudePlugins?.router.installed
                  ? t("plugins.routerVersion", { version: claudePlugins.router.version ?? "?" })
                  : `${t("plugins.routerName")}: ${t("plugins.notInstalled")}`}</li>
              </ul>
              <PluginCommands router t={t} />
            </section>
            <section aria-labelledby="settings-cli-heading" className="page-card settings-card">
              <h3 className="page-card-title" id="settings-cli-heading">{t("toolbar.codexCli")}</h3>
              <div className="cli-panel">
                {cliChecking || !cliChecked ? <p className="cli-status" role="status"><LoaderCircle className="spin" size={18} />{t("cli.checking")}</p> : (
                  <p className="cli-status">
                    <Terminal size={18} />
                    {!cliInfo?.version
                      ? t("cli.missing")
                      : cliUpdateAvailable
                        ? t("cli.updateAvailable", { version: cliInfo.version, latest: cliInfo.latest_version || "" })
                        : cliInfo.latest_version === cliInfo.version
                          ? t("cli.upToDate", { version: cliInfo.version })
                          : t("cli.version", { version: cliInfo.version })}
                  </p>
                )}
                {cliInfo?.version && !cliInfo.supports_update ? <p>{t("cli.unsupported")}</p> : null}
                {cliUpdateAvailable ? <p>{busy === "codex-cli-update" ? t("cli.updatingNote") : t("cli.updateNote")}</p> : null}
                {cliResult ? <p className="cli-result" role="status">{t(cliResult.kind === "updated" ? "cli.updated" : "cli.sameVersion")}</p> : null}
                {cliError ? <p className="cli-error" role="alert">{t(({
                  not_installed: "cli.error.notInstalled",
                  unsupported: "cli.error.unsupported",
                  busy: "cli.error.busy",
                  codex_open: "cli.error.codexOpen",
                  update_failed: "cli.error.updateFailed",
                  verification_failed: "cli.error.verificationFailed",
                  inspect_failed: "cli.error.inspectFailed",
                  open_guide: "cli.error.openGuide",
                } as const)[cliError])}</p> : null}
                <div className="modal-actions">
                  <button className="button button-quiet" disabled={busy !== null} onClick={() => void api.openCodexCliGuide().catch(() => setCliError("open_guide"))} type="button">{t("cli.guide")}</button>
                  <button className="button button-secondary" disabled={busy !== null || cliChecking} onClick={() => void checkCodexCli()} type="button">{t("cli.checkAgain")}</button>
                  {cliUpdateAvailable ? (
                    <button className="button button-primary" disabled={busy !== null || cliChecking} onClick={() => void updateCodexCli()} type="button">
                      {busy === "codex-cli-update" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                      {busy === "codex-cli-update" ? t("cli.updating") : t("cli.update")}
                    </button>
                  ) : null}
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {section === "accounts" ? (
        <section className="accounts-section" aria-labelledby="accounts-heading">
          <h2 className="page-title accounts-page-title" tabIndex={-1}>{t("nav.accounts")}</h2>
          <div className="section-heading">
            <div className="section-heading-main">
              <h3 id="accounts-heading">
                {loading
                  ? t("accounts.loading")
                  : accounts.length === 1
                    ? t("accounts.savedOne")
                    : t("accounts.savedMany", { count: formatNumber(accounts.length, locale.formatLocale) })}
              </h3>
              {accounts.length && !storageRecovery ? (
                <button
                  aria-pressed={selectionMode}
                  className="button button-secondary section-select-button"
                  disabled={loading || busy !== null}
                  onClick={() => {
                    setSelectionMode((current) => !current);
                    setSelectedAccountIds([]);
                  }}
                  type="button"
                >
                  <ListChecks aria-hidden="true" size={15} />
                  {selectionMode ? t("accounts.doneSelecting") : t("accounts.select")}
                </button>
              ) : null}
            </div>
            <div className="section-heading-actions">
              {storageRecovery ? <p>{t("accounts.recoveryDescription")}</p> : null}
              <button className="button button-quiet" disabled={loading || busy !== null || refreshProgress !== null || storageRecovery} onClick={() => void refreshAll()} type="button">
                <RefreshCw className={refreshProgress ? "spin" : ""} size={16} />
                {refreshProgress
                  ? t("toolbar.refreshing", {
                    done: formatNumber(refreshProgress.done, locale.formatLocale),
                    total: formatNumber(refreshProgress.total, locale.formatLocale),
                  })
                  : t("common.refresh")}
              </button>
              <button
                className="button button-secondary"
                disabled={busy !== null || loading || storageRecovery || chatGptAccounts.length === 0 || wake?.status === "running"}
                onClick={() => void startWake()}
                type="button"
              >
                <Zap size={16} />
                {t("toolbar.wakeAll")}
              </button>
              <button
                className="button button-primary"
                disabled={loading || busy !== null || storageRecovery}
                onClick={() => openAddDialog()}
                type="button"
              >
                <Plus size={16} />
                {t("common.addAccount")}
              </button>
            </div>
          </div>

          {selectionMode && accounts.length ? (
            <div className="account-selection-bar" aria-label={t("accounts.selectionActions")}>
              <span>{t("accounts.selected", { count: formatNumber(selectedAccountIds.length, locale.formatLocale) })}</span>
              <div className="account-selection-controls">
                <button
                  className="text-button"
                  disabled={busy !== null || selectedAccountIds.length === accounts.length}
                  onClick={() => setSelectedAccountIds(accounts.map((account) => account.id))}
                  type="button"
                >
                  {t("accounts.selectAll")}
                </button>
                <button
                  className="text-button"
                  disabled={busy !== null || selectedAccountIds.length === 0}
                  onClick={() => setSelectedAccountIds([])}
                  type="button"
                >
                  {t("accounts.clearSelection")}
                </button>
                <button
                  className="button button-secondary"
                  disabled={busy !== null || selectedChatGptCount === 0}
                  onClick={() => void startSelectedWake()}
                  type="button"
                >
                  <Zap size={15} />
                  {t("common.wake")}
                </button>
                <button
                  className="button button-primary"
                  disabled={busy !== null || selectedAccountIds.length === 0}
                  onClick={() => {
                    confirm.disarm();
                    setDialog("export");
                  }}
                  type="button"
                >
                  <Download size={15} />
                  {t("common.export")}
                </button>
              </div>
            </div>
          ) : null}

          {invokeSettings && !loading && !storageRecovery ? (
            <AccountOrderCard
              error={orderError}
              onMove={moveInOrder}
              onReserve={(id, value) => setReserveDraft({ ...reserveValues, [id]: value })}
              onSave={() => void saveOrder()}
              order={orderList}
              reserve={reserveValues}
              saving={orderSaving}
              t={t}
            />
          ) : null}

          {loading ? (
            <div className="loading-state"><LoaderCircle className="spin" size={24} />{t("accounts.reading")}</div>
          ) : storageRecovery ? (
            <section className="storage-recovery-state" aria-labelledby="storage-recovery-title">
              <ShieldAlert size={28} />
              <div>
                <h3 id="storage-recovery-title">{t("accounts.protectedTitle")}</h3>
                <p>{t("accounts.protectedBody")}</p>
              </div>
              <button
                className="button button-primary"
                onClick={() => {
                  confirm.disarm();
                  setDialog("storage-recovery");
                }}
                type="button"
              >
                {t("safety.reviewRecovery")}
              </button>
            </section>
          ) : accounts.length ? (
            <div className="account-grid">
              {accounts.map((account) => (
                <AccountCard
                  account={account}
                  active={account.active || account.id === currentActiveId}
                  busyAction={accountBusy[account.id] ?? (busy === "switch:" + account.id ? "switch" : undefined)}
                  formatLocale={locale.formatLocale}
                  now={clock}
                  globalBusy={accountGridBusy}
                  key={account.id}
                  onCopyEmail={() => void copyAccountEmail(account)}
                  onReauthenticate={() => void startOAuth(account)}
                  onApply={() => void switchAccount(account)}
                  onRefresh={() => void refreshAccount(account)}
                  onRemove={() => {
                    setRemoveAccount(account);
                    setRemoveError(null);
                    setDialog("remove");
                  }}
                  onReset={() => {
                    if (pendingResetCredit) {
                      setDialog("recover-reset-credit");
                      return;
                    }
                    setResetAccount(account);
                    confirm.disarm();
                    setDialog("reset");
                  }}
                  resetRecoveryRequired={pendingResetCredit}
                  onSwitch={() => void switchAccount(account)}
                  onWake={() => void startWake(account.id)}
                  onSelectionChange={() => {
                    setSelectedAccountIds((current) =>
                      current.includes(account.id)
                        ? current.filter((id) => id !== account.id)
                        : [...current, account.id],
                    );
                  }}
                  invokeMode={invokeSettings?.invoke_mode === true}
                  onInvokeAllowedChange={(allowed) => void changeAccountInvokeAllowed(account, allowed)}
                  quota={quotas[account.id]}
                  quotaFailure={quotaFailures[account.id]}
                  reauthenticationAvailable={account.kind === "chat_gpt" && (account.sign_in_required === true || quotaFailures[account.id] === "authentication" || accountSignInNeeded[account.id] === true)}
                  selected={selectedAccountIds.includes(account.id)}
                  selectionMode={selectionMode}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <FirstRun
              busy={loading || busy !== null}
              onSignIn={() => void startOAuth()}
              onImport={() => void chooseImportFile()}
              onSelectMethod={openAddDialog}
              t={t}
            />
          )}
        </section>
        ) : null}
      </div>

      {watching.length ? (
        <Modal className={watching.length > 1 ? "task-logs-modal" : ""} onClose={() => setWatching([])} t={t}
          title={watching.length === 1 ? watching[0].title : t("log.watchTitle")} wide>
          {watchChoices.length > 1 ? (
            <div className="task-log-picker">
              <select aria-label={t("log.watchAnother")} value="" onChange={(event) => {
                const choice = watchChoices.find((log) => log.id === event.target.value);
                if (choice) watchLog(choice);
              }}>
                <option value="" disabled>{t("log.watchAnother")}</option>
                {watchChoices.map((log) => <option key={log.id} value={log.id}>{log.title}</option>)}
              </select>
            </div>
          ) : null}
          <div className={"task-log-grid" + (watching.length > 1 ? " task-log-grid-multiple" : "")}>
            {watching.map((log) => {
              const task = tasks.find((candidate) => candidate.id === log.taskId || (log.threadId && candidate.thread_id === log.threadId));
              return <TaskLog key={log.id} formatLocale={locale.formatLocale} live={Boolean(task)}
                onClose={() => closeLog(log.id)} focus={log.focus} showHeader={watching.length > 1} t={t}
                threadId={task?.thread_id ?? log.threadId} title={log.title} />;
            })}
          </div>
        </Modal>
      ) : null}

      {dialog === "add" ? (
        <Modal dismissible={!runningAny("import", "migration-scan", "migration-import", "oauth", "oauth-cancel", "oauth-retry", "import-json", "import-key")} onClose={closeAddDialog} t={t} title={t(oauthTarget ? "oauth.reauthenticateTitle" : "add.title", oauthTarget ? { name: accountPrimaryName(oauthTarget) } : undefined)} wide>
          {addMethod === "start" ? (
            <AddAccountMethods
              busy={busy !== null}
              onSignIn={() => void startOAuth()}
              onImport={() => void chooseImportFile()}
              onSelectMethod={openAddDialog}
              t={t}
            />
          ) : null}

          {addMethod === "migration" ? (
            <div className="migration-flow">
              <button className="back-link" disabled={busy !== null} onClick={() => setAddMethod("start")} type="button">{t("migration.back")}</button>
              <h3>{t("migration.title")}</h3>
              <p>{t("migration.body")}</p>
              {!migrationScanned ? (
                <div className="modal-actions migration-actions">
                  <button className="button button-secondary" disabled={busy !== null} onClick={() => void chooseMigrationFolder()} type="button">
                    <FolderOpen size={16} />
                    {t("migration.chooseFolder")}
                  </button>
                  <button className="button button-primary" disabled={busy !== null} onClick={() => void scanMigration()} type="button">
                    {busy === "migration-scan" ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                    {t("migration.scan")}
                  </button>
                </div>
              ) : (
                <>
                  {migrationPreview?.candidates.length ? (
                    <div className="migration-list" aria-label={t("migration.title")}>
                      {migrationPreview.candidates.map((candidate) => {
                        const disabled = candidate.state !== "new";
                        const checked = migrationSelection.includes(candidate.id);
                        const primary = candidate.email || candidate.workspace_name || t("common.unknown");
                        return (
                          <label className={`migration-item migration-${candidate.state}`} key={candidate.id}>
                            <input
                              checked={checked}
                              disabled={disabled || busy !== null}
                              onChange={() => {
                                setMigrationSelection((current) =>
                                  checked
                                    ? current.filter((id) => id !== candidate.id)
                                    : [...current, candidate.id],
                                );
                              }}
                              type="checkbox"
                            />
                            <span className="migration-item-copy">
                              <strong>{primary}</strong>
                              <small>
                                {migrationSourceLabel(candidate, t)} · {migrationStateLabel(candidate, t)}
                                {candidate.workspace_name && candidate.workspace_name !== primary
                                  ? ` · ${t("migration.workspace", { name: candidate.workspace_name })}`
                                  : ""}
                                {candidate.plan_type ? ` · ${t("migration.plan", { plan: planLabel(candidate.plan_type, t) })}` : ""}
                              </small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="dialog-footnote">{t("migration.empty")}</p>
                  )}
                  {!migrationSelection.length && migrationPreview?.candidates.some((candidate) => candidate.state === "new") ? (
                    <p className="dialog-footnote">{t("migration.noSelection")}</p>
                  ) : null}
                  <div className="modal-actions migration-actions">
                    <button className="button button-secondary" disabled={busy !== null} onClick={() => void chooseMigrationFolder()} type="button">
                      <FolderOpen size={16} />
                      {t("migration.chooseFolder")}
                    </button>
                    <button className="button button-quiet" disabled={busy !== null} onClick={() => void scanMigration(migrationRoot)} type="button">
                      <RefreshCw size={16} />
                      {t("migration.rescan")}
                    </button>
                    <button className="button button-primary" disabled={!migrationSelection.length || busy !== null} onClick={() => void confirmMigration()} type="button">
                      {busy === "migration-import" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                      {t("migration.import")}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {addMethod === "oauth" && oauth ? (
            <div className="oauth-flow">
              {oauthTarget ? <div className="oauth-target">
                <span>{t("oauth.targetEmail", { email: oauthTarget.email || accountPrimaryName(oauthTarget) })}</span>
                {oauthTarget.workspace_name ? <span>{t("oauth.targetWorkspace", { workspace: oauthTarget.workspace_name })}</span> : null}
                {oauthTarget.email ? <button className="text-button" onClick={() => void copyAccountEmail(oauthTarget)} type="button">{t("account.copyEmail")}</button> : null}
              </div> : null}
              {oauth.status.status === "pending" ? (
                <>
                  <div className="oauth-hero">
                    <LoaderCircle className="spin" size={26} />
                    <div><h3>{t("oauth.finishTitle")}</h3><p>{t(oauthTarget ? "oauth.reauthenticateBody" : "oauth.finishBody")}</p></div>
                  </div>
                  {oauthStatusUnavailable ? <p className="inline-warning" role="status">{t("error.oauthStatus")}</p> : null}
                  <label className="field-label" htmlFor="oauth-link">{t("oauth.link")}</label>
                  <div className="copy-field">
                    <input id="oauth-link" readOnly value={oauth.auth_url} />
                    <button aria-label={t("oauth.copyLink")} className="icon-button" onClick={() => void copyOAuthUrl()} type="button"><Copy size={17} /></button>
                  </div>
                  <div className="modal-actions">
                    <button className="button button-secondary" onClick={() => void cancelOAuth()} type="button">{t("oauth.cancel")}</button>
                    <button className="button button-primary" onClick={() => void api.openOAuth(oauth.login_id).catch(() => setNotice({ kind: "error", text: t("oauth.openFailed") }))} type="button"><AppWindow size={16} />{t("oauth.openBrowser")}</button>
                  </div>
                </>
              ) : oauth.status.status === "finishing" ? (
                <div className="oauth-hero" role="status">
                  <LoaderCircle className="spin" size={26} />
                  <div><h3>{t("oauth.finishing")}</h3><p>{t("oauth.finishingBody")}</p></div>
                </div>
              ) : oauth.status.status === "complete" ? (
                <div className="outcome-panel">
                  <CircleCheck size={26} />
                  <h3>{t(oauthTarget ? "oauth.reauthenticated" : "oauth.added", { name: accountPrimaryName(oauth.status.account) })}</h3>
                  {oauth.status.account.needs_apply ? <p>{t(oauth.status.account.active ? "oauth.pendingApplyCurrent" : "oauth.pendingApplyOther")}</p> : null}
                  {oauth.status.cleanup_warning ? <p>{t("oauth.cleanupWarning")}</p> : null}
                  <button className="button button-primary" onClick={closeAddDialog} type="button">{t("common.done")}</button>
                </div>
              ) : (
                <div className="outcome-panel">
                  <CircleAlert size={26} />
                  <h3>{oauth.status.status === "cancelled" ? t("oauth.cancelled") : t("oauth.incomplete")}</h3>
                  <p>{oauth.status.status === "failed" ? oauthFailureMessage(t, oauth.status.code) : t("oauth.unchanged")}</p>
                  {oauth.status.status === "failed" && oauth.status.retryable ? (
                    <button className="button button-primary" onClick={() => void retryOAuthSave()} type="button">{t("oauth.retrySave")}</button>
                  ) : <button className="button button-primary" onClick={() => void startOAuth(oauthTarget ?? undefined)} type="button">{t("oauth.retry")}</button>}
                </div>
              )}
            </div>
          ) : null}

          {addMethod === "json" ? (
            <form className="credential-form" onSubmit={submitJson}>
              <button className="back-link" disabled={busy !== null} onClick={() => setAddMethod("start")} type="button">{t("form.allMethods")}</button>
              <h3>{t("form.pasteTitle")}</h3>
              <p>{t("form.pasteBody")}</p>
              <label className="field-label" htmlFor="account-label">{t("form.displayName")} <span>{t("common.optional")}</span></label>
              <input id="account-label" onChange={(event) => setLabel(event.target.value)} value={label} />
              <label className="field-label" htmlFor="auth-json">auth.json</label>
              <textarea id="auth-json" ref={jsonRef} required spellCheck={false} />
              <div className="modal-actions">
                <button className="button button-secondary" disabled={busy !== null} onClick={() => setAddMethod("start")} type="button">{t("common.cancel")}</button>
                <button className="button button-primary" disabled={busy !== null} type="submit">
                  {busy === "import-json" ? <LoaderCircle className="spin" size={16} /> : <FileJson size={16} />}
                  {t("common.addAccount")}
                </button>
              </div>
            </form>
          ) : null}

          {addMethod === "api-key" ? (
            <form className="credential-form" onSubmit={submitApiKey}>
              <button className="back-link" disabled={busy !== null} onClick={() => setAddMethod("start")} type="button">{t("form.allMethods")}</button>
              <h3>{t("form.apiKeyTitle")}</h3>
              <p>{t("form.apiKeyBody")}</p>
              <label className="field-label" htmlFor="api-label">{t("form.displayName")} <span>{t("common.optional")}</span></label>
              <input id="api-label" onChange={(event) => setLabel(event.target.value)} value={label} />
              <label className="field-label" htmlFor="api-key">{t("account.apiKey")}</label>
              <input autoComplete="off" id="api-key" ref={apiKeyRef} required spellCheck={false} type="password" />
              <div className="modal-actions">
                <button className="button button-secondary" disabled={busy !== null} onClick={() => setAddMethod("start")} type="button">{t("common.cancel")}</button>
                <button className="button button-primary" disabled={busy !== null} type="submit">
                  {busy === "import-key" ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  {t("common.addAccount")}
                </button>
              </div>
            </form>
          ) : null}
        </Modal>
      ) : null}

      {dialog === "export" ? (
        <Modal
          dismissible={!runningAny("export-accounts")}
          onClose={() => {
            confirm.disarm();
            setDialog(null);
          }}
          t={t}
          title={t(selectedAccountIds.length === 1 ? "export.headingOne" : "export.headingMany", { count: formatNumber(selectedAccountIds.length, locale.formatLocale) })}
        >
          <div className="confirm-panel">
            <ShieldAlert size={26} />
            <p>{t("export.body")}</p>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                disabled={busy !== null}
                onClick={() => {
                  confirm.disarm();
                  setDialog(null);
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button
                className="button button-danger"
                data-confirm="export"
                disabled={busy !== null || selectedAccountIds.length === 0}
                onClick={() => confirm.click("export", () => void exportSelectedAccounts())}
                type="button"
              >
                {busy === "export-accounts" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                {confirm.armed === "export" ? t("export.confirm") : t("export.write")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === "storage-recovery" ? (
        <Modal
          dismissible={!runningAny("reset-damaged-store")}
          onClose={() => {
            confirm.disarm();
            setDialog(null);
          }}
          t={t}
          title={t("recovery.storageTitle")}
        >
          <div className="confirm-panel">
            <ShieldAlert size={26} />
            <p>{t("recovery.storageBody")}</p>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                disabled={busy !== null}
                onClick={() => {
                  confirm.disarm();
                  setDialog(null);
                }}
                type="button"
              >
                {t("common.cancel")}
              </button>
              <button
                className="button button-danger"
                data-confirm="reset-storage"
                disabled={busy !== null}
                onClick={() => confirm.click("reset-storage", () => void resetDamagedAccountStore())}
                type="button"
              >
                {busy === "reset-damaged-store" ? <LoaderCircle className="spin" size={16} /> : <ShieldAlert size={16} />}
                {confirm.armed === "reset-storage" ? t("recovery.confirmResetStorage") : t("recovery.resetStorage")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === "enable-switching" ? (
        <Modal dismissible={!runningAny("enable-switching")} onClose={() => setDialog(null)} t={t} title={t("switching.title")}>
          <div className="confirm-panel">
            <ShieldAlert size={26} />
            <p>{t("switching.body")}</p>
            <div className="modal-actions">
              <button className="button button-secondary" disabled={busy !== null} onClick={() => setDialog(null)} type="button">{t("common.cancel")}</button>
              <button
                className="button button-primary"
                disabled={busy !== null}
                onClick={() =>
                  void runTask("enable-switching", api.enableAccountSwitching).then((enabled) => {
                    if (enabled) {
                      setDialog(null);
                      setNotice({ kind: "success", text: t("notice.switchingReady") });
                    }
                  })
                }
                type="button"
              >
                {t("switching.enable")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === "recover-switch" ? (
        <Modal dismissible={!runningAny("recover-switch")} onClose={() => setDialog(null)} t={t} title={t("recovery.switchTitle")}>
          <div className="confirm-panel">
            <CircleAlert size={26} />
            <p>{t("recovery.switchBody")}</p>
            <div className="modal-actions">
              <button className="button button-secondary" disabled={busy !== null} onClick={() => setDialog(null)} type="button">{t("common.cancel")}</button>
              <button
                className="button button-primary"
                disabled={busy !== null}
                onClick={() =>
                  void runVoidTask("recover-switch", api.recoverPendingSwitch).then((recovered) => {
                    if (recovered) {
                      setDialog(null);
                      setNotice({ kind: "success", text: t("notice.switchRecovered") });
                    }
                  })
                }
                type="button"
              >
                {t("recovery.recoverSafely")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === "recover-reset-credit" ? (
        <Modal
          dismissible={!runningAny("recover-reset-credit", "discard-reset-credit")}
          onClose={() => {
            setDiscardConfirmation(false);
            setDialog(null);
          }}
          t={t}
          title={t("recovery.resetTitle")}
        >
          <div className="confirm-panel">
            <CircleAlert size={26} />
            <p>{t("recovery.resetBody", { name: pendingResetAccount ? accountPrimaryName(pendingResetAccount) : t("recovery.removedAccount") })}</p>
            {discardConfirmation ? <p>{t("recovery.discardWarning")}</p> : null}
            <div className="modal-actions">
              {pendingReset?.discardable ? (
                <button className="button button-danger" disabled={busy !== null} onClick={() => void discardPendingReset()} type="button">
                  {busy === "discard-reset-credit" ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                  {discardConfirmation ? t("recovery.confirmDiscard") : t("recovery.discard")}
                </button>
              ) : null}
              {pendingResetAccount ? (
                <button
                  className="button button-primary"
                  disabled={busy !== null}
                  onClick={() => void recoverPendingResetCredit()}
                  type="button"
                >
                  {busy === "recover-reset-credit" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  {t("recovery.retry")}
                </button>
              ) : null}
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === "reset" && resetAccount ? (
        <Modal
          dismissible={!runningAny("reset:")}
          onClose={() => {
            confirm.disarm();
            setDialog(null);
          }}
          t={t}
          title={t("reset.title", { name: resetDialogName(resetAccount) })}
        >
          <div className="reset-details">
            <div className="credit-list-head">
              <span className="badge badge-active">{t("reset.availableCount", { count: formatNumber(resetCredits?.available_count ?? 0, locale.formatLocale) })}</span>
            </div>
            {!resetCredits?.details_available ? (
              <div className="inline-warning"><CircleAlert size={17} />{t("reset.detailsUnavailable")}</div>
            ) : resetCredits.usable_credits.length ? (
              <ul className="credit-list">
                {resetCredits.usable_credits.map((credit, index) => {
                  const pick = `reset-${credit.expires_at ?? "none"}-${credit.granted_at ?? "none"}-${index}`;
                  const expiry = credit.expires_at ? formatDateTime(credit.expires_at, locale.formatLocale) : undefined;
                  const armed = confirm.armed === pick;
                  return (
                    <li key={pick}>
                      <span className="credit-copy">
                        <strong>{credit.title ?? t("reset.creditTitleFallback")}</strong>
                        <small>
                          {credit.expires_at
                            ? t("reset.expiresAt", { date: expiry!, relative: formatRelativeTime(credit.expires_at, locale.formatLocale) })
                            : t("reset.expiryUnknown")}
                        </small>
                      </span>
                      <button
                        aria-label={expiry
                          ? t(armed ? "reset.confirmLabel" : "reset.useLabel", { date: expiry })
                          : t(armed ? "reset.confirmLabelUndated" : "reset.useLabelUndated")}
                        className={"button " + (armed ? "button-danger" : "button-secondary")}
                        data-confirm={pick}
                        disabled={busy !== null}
                        onClick={() => confirm.click(pick, () => void redeemReset(credit, pick))}
                        type="button"
                      >
                        {redeemingCredit === pick ? <LoaderCircle className="spin" size={15} /> : null}
                        {armed ? t("reset.confirm") : t("reset.use")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="inline-warning"><CircleAlert size={17} />{t("reset.noneUsable")}</div>
            )}
            {resetCredits?.details_available && resetCredits.available_count > resetCredits.usable_credits.length ? (
              <p className="credit-unlisted">
                {t("reset.unlisted", { count: formatNumber(resetCredits.available_count - resetCredits.usable_credits.length, locale.formatLocale) })}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {dialog === "remove" && removeAccount ? (
        <Modal
          dismissible={!runningAny("remove:")}
          onClose={() => {
            setDialog(null);
            setRemoveError(null);
          }}
          t={t}
          title={t("remove.title", { name: accountPrimaryName(removeAccount) })}
        >
          <div className="confirm-panel">
            <Trash2 size={26} />
            <p>{t("remove.body")}</p>
            <div className="remove-account-identity">
              <strong>{accountPrimaryName(removeAccount)}</strong>
              {accountSecondaryName(removeAccount, accountPrimaryName(removeAccount), t) ? (
                <span>{accountSecondaryName(removeAccount, accountPrimaryName(removeAccount), t)}</span>
              ) : null}
            </div>
            {removeError ? <p className="remove-error" role="alert">{removeError}</p> : null}
            <div className="modal-actions">
              <button className="button button-secondary" disabled={busy !== null} onClick={() => { setDialog(null); setRemoveError(null); }} type="button">{t("common.cancel")}</button>
              <button className="button button-danger" disabled={busy !== null} onClick={() => void removeSavedAccount()} type="button"><Trash2 size={16} />{t("remove.confirm")}</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === "wake" && wake ? (
        <Modal dismissible={wake.status !== "running" && !runningAny("wake-all", "wake-selected", "cancel-wake")} onClose={() => { setDialog(null); setWake(null); }} t={t} title={t("wake.title")}>
          <div className="wake-panel">
            <div className="wake-status">
              {wake.status === "running" ? <LoaderCircle className="spin" size={21} /> : wake.status === "completed" ? <Info size={21} /> : <CircleAlert size={21} />}
              <div>
                <strong>{wake.status === "running" ? t("wake.running") : wake.status === "completed" ? t("wake.resultsTitle") : t("wake.stopped")}</strong>
                <p>{wake.status === "running" ? t("wake.processed", { count: wake.results.length }) : wakeSummary(wake, t)}</p>
                {wake.status === "running" && wakeStatusUnavailable ? <p role="status">{t("error.wakeStatus")}</p> : null}
              </div>
            </div>
            {wake.results.length > 0 ? <ul className="wake-results">
              {wake.results.map((result, index) => {
                const account = accounts.find((saved) => saved.id === result.account_id);
                const primary = account ? accountPrimaryName(account) : result.label;
                const secondary = account ? accountSecondaryName(account, primary, t) : undefined;
                return (
                  <li key={result.account_id + "-" + result.result + "-" + index}>
                    <span className={"wake-result-dot wake-" + result.result} />
                    <div>
                      <div className="wake-result-identity">
                        <strong>{primary}</strong>
                        {secondary ? <span>{secondary}</span> : null}
                      </div>
                      <p>{wakeResultLabel(result, wake.alternate_model === true, t)}</p>
                      {result.result === "needs_sign_in" && account ? (
                        <button className="wake-retry" onClick={() => void startOAuth(account)} type="button">{t("account.signInAgain")}</button>
                      ) : null}
                      {wake.status !== "running" && result.result === "model_unavailable" && !wake.alternate_model ? (
                        <button
                          className="wake-retry"
                          disabled={busy !== null}
                          onClick={() => void startWake(result.account_id, true)}
                          aria-label={t("wake.retryAlternateFor", { name: primary })}
                          type="button"
                        >
                          {t("wake.retryAlternate")}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul> : null}
            <div className="modal-actions">
              {wake.status === "running" ? (
                <button className="button button-secondary" disabled={busy !== null} onClick={() => void runVoidTask("cancel-wake", () => api.cancelWake(wake.id), false)} type="button">{t("wake.cancelRemaining")}</button>
              ) : null}
              {wake.status !== "running" ? <button className="button button-primary" disabled={busy !== null} onClick={() => {
                setDialog(null);
                setWake(null);
              }} type="button">{t("common.done")}</button> : null}
            </div>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
