import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";

import App from "./App";
import type { ClaudeSetup, AccountView, QuotaRefreshFailureCode, QuotaView, SwitchFailureCode } from "./types";

// The second click of a two-click confirmation is ignored for 300 ms.
const pastConfirmGuard = () => new Promise((resolve) => window.setTimeout(resolve, 320));

async function confirmResetRow(row = 0) {
  await userEvent.click(await screen.findByRole("button", { name: "Details" }));
  const use = (await screen.findAllByRole("button", { name: /^Use the reset credit expiring/ }))[row]!;
  await userEvent.click(use);
  await pastConfirmGuard();
  await userEvent.click(screen.getByRole("button", { name: /^Confirm the reset credit expiring/ }));
}

const mocks = vi.hoisted(() => ({
  runtimeInfo: vi.fn(),
  codexCliInfo: vi.fn(),
  updateCodexCli: vi.fn(),
  openCodexCliGuide: vi.fn(),
  appSnapshot: vi.fn(),
  listAccounts: vi.fn(),
  resetDamagedAccountStore: vi.fn(),
  liveAccount: vi.fn(),
  startOAuth: vi.fn(),
  oauthStatus: vi.fn(),
  retryOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  openOAuth: vi.fn(),
  importAuthJson: vi.fn(),
  importAuthFiles: vi.fn(),
  exportAccounts: vi.fn(),
  discoverLocalAccounts: vi.fn(),
  importLocalAccounts: vi.fn(),
  importApiKey: vi.fn(),
  saveCurrentAccount: vi.fn(),
  enableAccountSwitching: vi.fn(),
  switchAccount: vi.fn(),
  recoverPendingSwitch: vi.fn(),
  removeSavedAccount: vi.fn(),
  accountQuota: vi.fn(),
  refreshAccountQuota: vi.fn(),
  redeemResetCredit: vi.fn(),
  recoverPendingResetCredit: vi.fn(),
  discardPendingResetCredit: vi.fn(),
  startWake: vi.fn(),
  startWakeAll: vi.fn(),
  startWakeSelected: vi.fn(),
  wakeOperation: vi.fn(),
  cancelWake: vi.fn(),
  updateDelivery: vi.fn(),
  openLatestRelease: vi.fn(),
  invokeSettings: vi.fn(),
  setClaudeSetup: vi.fn(),
  modelCatalog: vi.fn(),
  setInvokeProfiles: vi.fn(),
  setAccountInvokeAllowed: vi.fn(),
  setInvokePreferences: vi.fn(),
  appVersion: vi.fn(),
  onInvokeAutoWoke: vi.fn(),
  invokeTasks: vi.fn(),
  stopInvokeTask: vi.fn(),
  pausedThreads: vi.fn(),
  activity: vi.fn(),
  onInvokeActivity: vi.fn(),
  onInvokeResumed: vi.fn(),
  setInvokeWeeklyReserve: vi.fn(),
  setInvokeTaskDefaults: vi.fn(),
  readTaskLog: vi.fn(),
  onInvokeAccountSwitched: vi.fn(),
  invokeFailover: vi.fn(),
  cancelInvokeFailover: vi.fn(),
  onInvokeFailoverWaiting: vi.fn(),
  invokePause: vi.fn(),
  resumeInvoke: vi.fn(),
  onInvokePaused: vi.fn(),
}));

const updaterMocks = vi.hoisted(() => ({
  check: vi.fn(),
  checkRollback: vi.fn(),
  relaunch: vi.fn(),
}));

const webviewMocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
}));

vi.mock("./api", () => ({
  api: mocks,
}));

vi.mock("./updater", () => ({
  updater: updaterMocks,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: webviewMocks.onDragDropEvent }),
}));

const chatAccount: AccountView = {
  id: "account-1",
  label: "Personal",
  kind: "chat_gpt",
  email: "person@example.com",
  workspace_name: "Personal",
  plan_type: "Plus",
  active: false,
};

const staleQuota: QuotaView = {
  account_id: "account-1",
  status: "stale",
  snapshot: {
    fetched_at_unix_ms: Date.now(),
    buckets: [
      {
        limit_id: "codex",
        kind: "codex",
        windows: [
          {
            kind: "five_hour",
            remaining_percent: 30,
            used_percent: 70,
            window_duration_mins: 300,
            resets_at: 1893456000,
          },
          {
            kind: "weekly",
            remaining_percent: 85,
            used_percent: 15,
            window_duration_mins: 10080,
            resets_at: 1894060800,
          },
        ],
      },
    ],
    reset_credits: {
      available_count: 2,
      nearest_expiry: 1893456000,
      details_available: true,
      can_redeem: true,
      usable_credits: [{ expires_at: 1893456000 }, { expires_at: 1894060800 }],
    },
  },
};

function claudeSetup(enabled = false): ClaudeSetup {
  return {
    setup: enabled ? "claude-codex" : "claude-only",
    codexSpeed: { mode: "normal", fastMinRemaining: 20 },
    router: {
      mode: "mixed",
      claudeAllowed: {
        haiku: ["low", "medium"],
        sonnet: ["low", "medium", "high", "xhigh", "max"],
        opus: ["low", "medium", "high", "xhigh", "max"],
      },
      claudeOnlyReview: "on",
      prefer: "codex",
      sampling: "on",
    },
  };
}

async function goTo(section: "Home" | "Accounts" | "Claude Code" | "Results" | "Settings") {
  const nav = await screen.findByRole("navigation", { name: "Sections" });
  await userEvent.click(within(nav).getByRole("button", { name: new RegExp(`^${section}`) }));
}

async function openClaudeSetup() {
  await goTo("Claude Code");
  return screen.findByRole("region", { name: "Claude Code" });
}

async function openInvokeSettings() {
  await goTo("Claude Code");
  return screen.findByRole("region", { name: "Codex helper" });
}

function prepareDefaults() {
  mocks.codexCliInfo.mockResolvedValue({ version: "0.156.1", latest_version: "0.157.0", update_status: "available", supports_update: true });
  mocks.updateCodexCli.mockResolvedValue({ version: "0.157.0", update_status: "unknown", supports_update: true });
  mocks.openCodexCliGuide.mockResolvedValue(undefined);
  mocks.runtimeInfo.mockResolvedValue({
    codex_home: "C:\\Codex",
    auth_file_exists: false,
    credential_store: "file",
  });
  mocks.listAccounts.mockResolvedValue([]);
  mocks.liveAccount.mockResolvedValue({
    status: "not_signed_in",
    credential_store: "file",
  });
  mocks.appSnapshot.mockImplementation(async () => ({
    storage: { status: "ready" },
    accounts: await mocks.listAccounts(),
    runtime: await mocks.runtimeInfo(),
    live: await mocks.liveAccount(),
  }));
  mocks.resetDamagedAccountStore.mockResolvedValue(undefined);
  mocks.accountQuota.mockResolvedValue({
    account_id: "unused",
    status: "unknown",
  });
  mocks.startOAuth.mockResolvedValue({
    login_id: "login-1",
    auth_url: "https://auth.openai.com/example",
  });
  mocks.oauthStatus.mockResolvedValue({ status: "pending" });
  mocks.cancelOAuth.mockResolvedValue(undefined);
  mocks.retryOAuth.mockResolvedValue(undefined);
  mocks.openOAuth.mockResolvedValue(undefined);
  mocks.importAuthJson.mockResolvedValue(chatAccount);
  mocks.importAuthFiles.mockResolvedValue({
    imported: [chatAccount],
    duplicate_count: 0,
    unsupported_count: 0,
    failed_count: 0,
  });
  mocks.exportAccounts.mockResolvedValue({ exported_count: 1, cancelled: false });
  mocks.discoverLocalAccounts.mockResolvedValue({ candidates: [] });
  mocks.importLocalAccounts.mockResolvedValue({
    imported: [chatAccount],
    duplicate_count: 0,
    unsupported_count: 0,
    failed_count: 0,
  });
  mocks.importApiKey.mockResolvedValue({
    id: "api-1",
    label: "Key",
    kind: "api_key",
    active: false,
  });
  mocks.saveCurrentAccount.mockResolvedValue(chatAccount);
  mocks.enableAccountSwitching.mockResolvedValue(true);
  mocks.switchAccount.mockResolvedValue({ account: chatAccount });
  mocks.recoverPendingSwitch.mockResolvedValue(undefined);
  mocks.removeSavedAccount.mockResolvedValue(undefined);
  mocks.refreshAccountQuota.mockResolvedValue(staleQuota);
  mocks.redeemResetCredit.mockResolvedValue({
    account_id: "account-1",
    outcome: "reset",
  });
  mocks.discardPendingResetCredit.mockResolvedValue(undefined);
  mocks.recoverPendingResetCredit.mockResolvedValue({
    account_id: "account-1",
    outcome: "nothing_to_reset",
  });
  mocks.startWake.mockResolvedValue({ operation_id: "wake-1" });
  mocks.startWakeAll.mockResolvedValue({ operation_id: "wake-all" });
  mocks.startWakeSelected.mockResolvedValue({ operation_id: "wake-selected" });
  mocks.wakeOperation.mockResolvedValue({
    id: "wake-1",
    status: "completed",
    results: [],
  });
  mocks.cancelWake.mockResolvedValue(undefined);
  mocks.updateDelivery.mockResolvedValue("installer_exits");
  mocks.openLatestRelease.mockResolvedValue(undefined);
  mocks.invokeSettings.mockResolvedValue({ invoke_mode: false, claude_setup: claudeSetup(false), allowed_invocation_profiles: [] });
  mocks.setClaudeSetup.mockImplementation(async (setup: ClaudeSetup) => ({
    invoke_mode: setup.setup === "claude-codex" || (setup.setup === "router"
      && (setup.router.mode !== "claude" || setup.router.claudeOnlyReview === "on")),
    claude_setup: setup,
    allowed_invocation_profiles: [],
  }));
  mocks.modelCatalog.mockResolvedValue([]);
  mocks.setInvokeProfiles.mockImplementation(async (profiles: unknown) => ({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: profiles }));
  mocks.appVersion.mockResolvedValue({ version: "1.2.0", dev: false });
  mocks.onInvokeAutoWoke.mockResolvedValue(() => undefined);
  mocks.invokeTasks.mockResolvedValue([]);
  mocks.stopInvokeTask.mockResolvedValue(undefined);
  mocks.pausedThreads.mockResolvedValue([]);
  mocks.readTaskLog.mockImplementation(async (_threadId: string, offset: number) => ({ found: true, items: [], offset }));
  mocks.activity.mockResolvedValue([]);
  mocks.onInvokeActivity.mockResolvedValue(() => undefined);
  mocks.onInvokeResumed.mockResolvedValue(() => undefined);
  mocks.setInvokeWeeklyReserve.mockImplementation(async (reserve: Record<string, number>) => ({
    invoke_mode: true, claude_setup: claudeSetup(true),
    allowed_invocation_profiles: [],
    weekly_reserve: reserve,
  }));
  mocks.setInvokeTaskDefaults.mockImplementation(async (task_defaults: unknown) => ({
    invoke_mode: true, claude_setup: claudeSetup(true),
    allowed_invocation_profiles: [],
    task_defaults,
  }));
  mocks.setInvokePreferences.mockImplementation(async (order: string[], min: number, tasks: number, autoWake: boolean) => ({
    auto_wake: autoWake,
    invoke_mode: true, claude_setup: claudeSetup(true),
    allowed_invocation_profiles: [],
    account_priority: order,
    preferred_min_remaining: min,
    max_concurrent_tasks: tasks,
  }));
  mocks.setAccountInvokeAllowed.mockImplementation(async (id: string, allowed: boolean) => ({ ...chatAccount, id, invoke_allowed: allowed }));
  mocks.onInvokeAccountSwitched.mockResolvedValue(() => undefined);
  mocks.invokeFailover.mockResolvedValue(null);
  mocks.cancelInvokeFailover.mockResolvedValue(undefined);
  mocks.onInvokeFailoverWaiting.mockResolvedValue(() => undefined);
  mocks.invokePause.mockResolvedValue(null);
  mocks.resumeInvoke.mockResolvedValue(undefined);
  mocks.onInvokePaused.mockResolvedValue(() => undefined);
  updaterMocks.check.mockResolvedValue(null);
  updaterMocks.checkRollback.mockResolvedValue(null);
  updaterMocks.relaunch.mockResolvedValue(undefined);
  webviewMocks.onDragDropEvent.mockResolvedValue(() => undefined);
}

describe("GSwitch account workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // Most tests here work in the Accounts section, as if the user chose it.
    window.localStorage.setItem("gswitch.section", "accounts");
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
    prepareDefaults();
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("shows and updates the same Codex CLI without touching accounts", async () => {
    let updated = false;
    mocks.codexCliInfo.mockImplementation(async () => updated
      ? { version: "0.157.0", latest_version: "0.157.0", update_status: "current", supports_update: true }
      : { version: "0.156.1", latest_version: "0.157.0", update_status: "available", supports_update: true });
    mocks.updateCodexCli.mockImplementation(async () => {
      updated = true;
      return { version: "0.157.0", update_status: "unknown", supports_update: true };
    });
    render(<App />);
    // An available CLI update marks the Settings section.
    await userEvent.click(await screen.findByRole("button", { name: /Codex CLI 0\.157\.0 available/ }, { timeout: 5_000 }));
    const panel = await screen.findByRole("region", { name: "Codex CLI" });
    expect(await within(panel).findByText("Codex CLI 0.156.1 · 0.157.0 available")).toBeInTheDocument();
    expect(within(panel).getByText(/updates only the CLI/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Update" }));
    expect(await within(panel).findByText("Update complete.")).toBeInTheDocument();
    // The version appears once, in the status line.
    expect(within(panel).getByText("Codex CLI 0.157.0 · up to date")).toBeInTheDocument();
    expect(within(panel).getAllByText(/0\.157\.0/)).toHaveLength(1);
    expect(within(panel).queryByText(/updates only the CLI/)).not.toBeInTheDocument();
    expect(mocks.updateCodexCli).toHaveBeenCalledOnce();
    expect(mocks.switchAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Codex CLI .* available/ })).not.toBeInTheDocument();
  });

  it("keeps CLI update failures in the Codex CLI panel with a next step", async () => {
    mocks.updateCodexCli.mockRejectedValue("codex_open");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Codex CLI 0\.157\.0 available/ }, { timeout: 5_000 }));
    const panel = await screen.findByRole("region", { name: "Codex CLI" });
    expect(await within(panel).findByText("Codex CLI 0.156.1 · 0.157.0 available")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Update" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Quit Codex, then try the update again.");
    expect(within(panel).getByText("Codex CLI 0.156.1 · 0.157.0 available")).toBeInTheDocument();
  });

  it("keeps a CLI update failure that happened while Settings was closed", async () => {
    let reject: (reason: unknown) => void = () => {};
    mocks.updateCodexCli.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Codex CLI 0\.157\.0 available/ }, { timeout: 5_000 }));
    const panel = await screen.findByRole("region", { name: "Codex CLI" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Update" }));
    await goTo("Home");
    await act(async () => reject("codex_open"));
    await goTo("Settings");
    expect(await within(await screen.findByRole("region", { name: "Codex CLI" })).findByRole("alert"))
      .toHaveTextContent("Quit Codex, then try the update again.");
  });

  it("moves focus to the page heading after a sidebar click, not on first load", async () => {
    window.localStorage.setItem("gswitch.section", "results");
    render(<App />);
    const results = await screen.findByRole("heading", { name: "Activity" });
    expect(results).not.toHaveFocus();
    await goTo("Settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toHaveFocus();
  });

  it("shows Checking instead of 'not found' until the first Codex CLI check returns", async () => {
    window.localStorage.setItem("gswitch.section", "settings");
    let resolveInfo: (info: { version: string; update_status: string; supports_update: boolean }) => void = () => undefined;
    mocks.codexCliInfo.mockImplementation(() => new Promise((resolve) => { resolveInfo = resolve; }));
    render(<App />);
    const panel = await screen.findByRole("region", { name: "Codex CLI" });
    expect(within(panel).getByText("Checking Codex CLI…")).toBeInTheDocument();
    expect(within(panel).queryByText("No working Codex CLI was found.")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.codexCliInfo).toHaveBeenCalled(), { timeout: 5_000 });
    await act(async () => resolveInfo({ version: "0.157.0", update_status: "current", supports_update: true }));
    expect(await within(panel).findByText("Codex CLI 0.157.0")).toBeInTheDocument();
    expect(within(panel).queryByText("Checking Codex CLI…")).not.toBeInTheDocument();
  });

  it("gives Accounts a page title above its saved-accounts heading and focuses it", async () => {
    window.localStorage.setItem("gswitch.section", "home");
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    render(<App />);
    await screen.findByRole("heading", { name: "Home" });
    await goTo("Accounts");
    const title = await screen.findByRole("heading", { level: 2, name: "Accounts" });
    expect(title).toHaveFocus();
    expect(await screen.findByRole("heading", { level: 3, name: "1 saved account" })).toBeInTheDocument();
  });

  it("does not offer an update to a CLI without the official command", async () => {
    mocks.codexCliInfo.mockResolvedValue({ version: "0.100.0", latest_version: "0.157.0", update_status: "available", supports_update: false });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Codex CLI 0\.157\.0 available/ }, { timeout: 5_000 }));
    const panel = await screen.findByRole("region", { name: "Codex CLI" });
    expect(await within(panel).findByText("Codex CLI 0.100.0")).toBeInTheDocument();
    expect(within(panel).getByText(/can't update itself/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Official install guide" })).toBeInTheDocument();
  });

  it("keeps current and offline CLI checks out of the sidebar", async () => {
    mocks.codexCliInfo.mockResolvedValue({ version: "0.157.0", latest_version: "0.157.0", update_status: "current", supports_update: true });
    render(<App />);
    await screen.findByRole("heading", { name: "0 saved accounts" });
    await waitFor(() => expect(mocks.codexCliInfo).toHaveBeenCalled(), { timeout: 5_000 });
    expect(screen.queryByRole("button", { name: /Codex CLI .* available/ })).not.toBeInTheDocument();
  });

  it("keeps a failed CLI release check quiet", async () => {
    mocks.codexCliInfo.mockResolvedValue({ version: "0.157.0", update_status: "unknown", supports_update: true });
    render(<App />);
    await waitFor(() => expect(mocks.codexCliInfo).toHaveBeenCalled(), { timeout: 5_000 });
    expect(screen.queryByRole("button", { name: /Codex CLI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("switches sections from the sidebar and remembers the choice", async () => {
    window.localStorage.removeItem("gswitch.section");
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    const first = render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    const home = within(nav).getByRole("button", { name: "Home" });
    await waitFor(() => expect(home).toHaveAttribute("aria-current", "page"));

    await goTo("Results");
    expect(within(nav).getByRole("button", { name: "Results" })).toHaveAttribute("aria-current", "page");
    expect(home).not.toHaveAttribute("aria-current");
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(window.localStorage.getItem("gswitch.section")).toBe("results");

    await goTo("Accounts");
    expect(await screen.findByRole("heading", { name: "1 saved account" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Activity" })).not.toBeInTheDocument();
    await goTo("Results");

    first.unmount();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: "Results" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("opens Accounts by default before any account is saved and Home afterwards", async () => {
    window.localStorage.removeItem("gswitch.section");
    const first = render(<App />);
    expect(await screen.findByRole("heading", { name: "Add your Codex accounts" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("button", { name: /^Accounts/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: /^Accounts/ })).toHaveTextContent("0");
    // A default is not a choice, so nothing is remembered.
    expect(window.localStorage.getItem("gswitch.section")).toBeNull();
    first.unmount();

    mocks.listAccounts.mockResolvedValue([chatAccount]);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "1 saved account" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: /^Accounts/ }))
      .toHaveTextContent("1");
  });

  it("has no language control", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "0 saved accounts" });
    expect(screen.queryByRole("button", { name: /Language/ })).not.toBeInTheDocument();
    await goTo("Settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText(/Language|简体中文/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Language|English/ })).not.toBeInTheDocument();
  });

  it("offers the same sign-in and import choices on first use and in Add account", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "0 saved accounts" })).toBeInTheDocument();
    const firstRun = screen.getByRole("heading", { name: "Add your Codex accounts" }).closest("section")!;
    expect(within(firstRun).getAllByRole("button").slice(0, 3).map((button) => button.querySelector("strong")?.textContent))
      .toEqual(["Sign in", "Find on this computer", "Choose files"]);
    expect(within(firstRun).getByText("Paste auth JSON")).not.toBeVisible();
    expect(screen.queryByText("Add manually")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add account" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Codex account" });
    expect(within(dialog).getAllByRole("button").slice(1, 4).map((button) => button.querySelector("strong")?.textContent))
      .toEqual(["Sign in", "Find on this computer", "Choose files"]);
    expect(within(dialog).getByText("Paste auth JSON")).not.toBeVisible();
    await userEvent.click(within(dialog).getByText("Other methods"));
    expect(within(dialog).getByRole("button", { name: /Paste auth JSON/ })).toBeInTheDocument();
    expect(within(dialog).queryByText("Import existing")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Add new")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Choose files/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/Select one or more account files/i)).toBeInTheDocument();
  });

  it("starts browser sign-in directly from first use and blocks another start while pending", async () => {
    let finishStart!: (value: { login_id: string; auth_url: string }) => void;
    mocks.startOAuth.mockImplementation(() => new Promise((resolve) => { finishStart = resolve; }));
    render(<App />);
    const signIn = await screen.findByRole("button", { name: /^Sign in / });
    await userEvent.dblClick(signIn);
    expect(mocks.startOAuth).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(signIn).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Find on this computer/ })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    finishStart({ login_id: "login-1", auth_url: "https://example.com/sign-in" });
    expect(await screen.findByText("Finish sign-in in your browser")).toBeInTheDocument();
    expect(mocks.openOAuth).not.toHaveBeenCalled();
    expect(mocks.discoverLocalAccounts).not.toHaveBeenCalled();
    expect(mocks.importAuthFiles).not.toHaveBeenCalled();
  });

  it("keeps first-use choices available when browser sign-in cannot start", async () => {
    mocks.startOAuth.mockRejectedValue("network");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Sign in / }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sign in / })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Choose files/ })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens other methods directly from the first-use screen", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Add your Codex accounts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sign in / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Find on this computer/ })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Other methods"));
    await userEvent.click(screen.getByRole("button", { name: /^Paste auth JSON/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Codex account" });
    expect(within(dialog).getByRole("textbox", { name: "auth.json" })).toBeInTheDocument();
    expect(mocks.startOAuth).not.toHaveBeenCalled();
    expect(mocks.discoverLocalAccounts).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus in a dialog and returns it to the launcher", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "0 saved accounts" });
    const launcher = screen.getByRole("button", { name: "Add account" });
    await user.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "Add a Codex account" });
    expect(dialog).toHaveFocus();

    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Close Add a Codex account" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByText("Other methods")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();
  });

  it("ignores a double-click on a two-click confirmation and disarms on an outside click", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("person@example.com");
    await user.click(screen.getByRole("button", { name: "Select accounts" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = screen.getByRole("dialog", { name: "Export 1 account" });

    await user.dblClick(within(dialog).getByRole("button", { name: "Export" }));
    expect(mocks.exportAccounts).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Confirm export" })).toBeInTheDocument();

    await user.click(within(dialog).getByText(/The exported file isn't encrypted/));
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(mocks.exportAccounts).not.toHaveBeenCalled();
  });

  it("keeps an export confirmation open while its save operation is pending", async () => {
    let finishExport!: (value: { exported_count: number; cancelled: boolean }) => void;
    mocks.exportAccounts.mockImplementation(() => new Promise((resolve) => { finishExport = resolve; }));
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("person@example.com");
    await user.click(screen.getByRole("button", { name: "Select accounts" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = screen.getByRole("dialog", { name: "Export 1 account" });
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await pastConfirmGuard();
    await user.click(within(dialog).getByRole("button", { name: "Confirm export" }));
    await waitFor(() => expect(mocks.exportAccounts).toHaveBeenCalledOnce());
    expect(within(dialog).getByRole("button", { name: "Close Export 1 account" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    finishExport({ exported_count: 1, cancelled: false });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("shows the current account on its card without repeating it in the sidebar", async () => {
    const account = { ...chatAccount, email: "a-very-long-account-name-that-must-truncate@example.com", active: true };
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.liveAccount.mockResolvedValue({
      status: "ready",
      credential_store: "file",
      account,
    });
    const { container } = render(<App />);

    const card = (await screen.findByRole("heading", { name: account.email })).closest("article")!;
    expect(within(card).getByText("Current", { selector: ".badge-active" })).toBeInTheDocument();
    expect(container.querySelector("header")).not.toHaveTextContent(account.email);
    expect(within(container.querySelector("header")!).getByRole("heading", { name: "GSwitch Claude Tool" })).toBeInTheDocument();
  });

  it("shows a signed-out notice with saved accounts and no extra action", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    render(<App />);
    const notice = await screen.findByText("Codex is signed out");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice.querySelector("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Switch to person@example.com" })).toBeInTheDocument();
  });

  it("uses the empty state without a duplicate signed-out notice", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "0 saved accounts" });
    expect(screen.getByRole("heading", { name: "Add your Codex accounts" })).toBeInTheDocument();
    expect(screen.queryByText("Codex is signed out")).not.toBeInTheDocument();
  });

  it("does not scan local account sources at startup or when the method row opens", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "0 saved accounts" })).toBeInTheDocument();
    expect(mocks.discoverLocalAccounts).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Find on this computer/ }));
    expect(screen.getByText(/Nothing is imported until you select accounts/i)).toBeInTheDocument();
    expect(mocks.discoverLocalAccounts).not.toHaveBeenCalled();
  });

  it("shows a sanitized migration preview and imports only selected new candidates", async () => {
    mocks.discoverLocalAccounts.mockResolvedValue({
      candidates: [
        {
          id: "new-id",
          source: "official_codex",
          email: "person@example.com",
          workspace_name: "Personal",
          plan_type: "Plus",
          state: "new",
        },
        {
          id: "existing-id",
          source: "cockpit_tools",
          email: "saved@example.com",
          state: "already_present",
        },
        {
          id: "unsupported-id",
          source: "cockpit_tools",
          email: "unknown@example.com",
          state: "unsupported",
        },
      ],
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /Find on this computer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Scan supported locations" }));

    expect(await screen.findByText("person@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Official Codex · New/)).toBeInTheDocument();
    expect(screen.getByText(/Already in GSwitch/)).toBeInTheDocument();
    expect(screen.getByText(/Unsupported/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).toBeDisabled();
    expect(screen.getAllByRole("checkbox")[2]).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(mocks.importLocalAccounts).toHaveBeenCalledWith(undefined, ["new-id"]));
  });

  it("uses the explicit folder choice only for a migration scan", async () => {
    vi.mocked(open).mockResolvedValue("C:\\custom\\cockpit");
    mocks.discoverLocalAccounts.mockResolvedValue({ candidates: [] });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /Find on this computer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Choose another Cockpit folder" }));

    await waitFor(() => expect(mocks.discoverLocalAccounts).toHaveBeenCalledWith("C:\\custom\\cockpit"));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  });

  it("opens the native picker for multiple account files and reports one summary", async () => {
    vi.mocked(open).mockResolvedValue(["C:\\exports\\one.json", "C:\\exports\\two.json"]);
    mocks.importAuthFiles.mockResolvedValue({
      imported: [chatAccount, { ...chatAccount, id: "account-2", email: "other@example.com" }],
      duplicate_count: 1,
      unsupported_count: 1,
      failed_count: 1,
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /^Choose files/ }));
    await waitFor(() =>
      expect(mocks.importAuthFiles).toHaveBeenCalledWith([
        "C:\\exports\\one.json",
        "C:\\exports\\two.json",
      ]),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
    expect(await screen.findByText("Import results — added: 2; already present or duplicate: 1; unsupported or failed: 2.")).toBeInTheDocument();
  });

  it("uses the same bounded batch command for one selected file", async () => {
    vi.mocked(open).mockResolvedValue(["C:\\exports\\one.json"]);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /^Choose files/ }));
    await waitFor(() => expect(mocks.importAuthFiles).toHaveBeenCalledWith(["C:\\exports\\one.json"]));
  });

  it("keeps a saved batch account when its later quota refresh fails", async () => {
    const imported = { ...chatAccount, id: "batch-account" };
    vi.mocked(open).mockResolvedValue(["C:\\exports\\one.json"]);
    mocks.importAuthFiles.mockImplementation(async () => {
      mocks.listAccounts.mockResolvedValue([imported]);
      return {
        imported: [imported],
        duplicate_count: 0,
        unsupported_count: 0,
        failed_count: 0,
      };
    });
    mocks.accountQuota.mockResolvedValue({ account_id: imported.id, status: "unknown" });
    mocks.refreshAccountQuota.mockRejectedValue(new Error("quota cache unavailable"));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /^Choose files/ }));
    expect(await screen.findByRole("heading", { name: "person@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to person@example.com" })).toBeEnabled();
  });

  it("passes every dropped path to the bounded batch command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    render(<App />);

    await waitFor(() => expect(webviewMocks.onDragDropEvent).toHaveBeenCalledOnce());
    const onEvent = webviewMocks.onDragDropEvent.mock.calls[0][0] as (event: unknown) => void;
    onEvent({ payload: { type: "drop", paths: ["C:\\exports\\one.json", "C:\\exports\\two.json"] } });
    await waitFor(() =>
      expect(mocks.importAuthFiles).toHaveBeenCalledWith([
        "C:\\exports\\one.json",
        "C:\\exports\\two.json",
      ]),
    );
  });

  it("contains a damaged account library until the user explicitly resets only GSwitch storage", async () => {
    mocks.appSnapshot.mockResolvedValue({
      storage: {
        status: "recovery_required",
        message: "GSwitch could not safely read its saved account library. Codex credentials were not changed.",
      },
      accounts: [],
    });
    render(<App />);

    expect(await screen.findByText("Saved accounts are protected until recovery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
    expect(screen.queryByText("Add your first Codex account")).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Review recovery" })[0]);
    expect(await screen.findByRole("dialog", { name: "Recover GSwitch account storage" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear and rebuild" }));
    expect(mocks.resetDamagedAccountStore).not.toHaveBeenCalled();

    await pastConfirmGuard();
    await userEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(mocks.resetDamagedAccountStore).toHaveBeenCalledOnce());
  });

  it("clears pasted auth JSON before the import request completes", async () => {
    let resolveImport: ((account: AccountView) => void) | undefined;
    mocks.importAuthJson.mockImplementation(
      () =>
        new Promise<AccountView>((resolve) => {
          resolveImport = resolve;
        }),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "0 saved accounts" });

    await userEvent.click(screen.getByRole("button", { name: /^Add account$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Codex account" });
    await userEvent.click(within(dialog).getByRole("button", { name: /Paste auth JSON/ }));
    const input = screen.getByLabelText("auth.json");
    fireEvent.change(input, { target: { value: '{"tokens":{"access_token":"secret"}}' } });
    await userEvent.click(within(dialog).getByRole("button", { name: /^Add account$/ }));

    expect(input).toHaveValue("");
    expect(mocks.importAuthJson).toHaveBeenCalledWith(
      '{"tokens":{"access_token":"secret"}}',
      undefined,
    );

    resolveImport?.(chatAccount);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("lists each reset credit with its own button that needs a second click", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    const withTitles: QuotaView = {
      ...staleQuota,
      snapshot: {
        ...staleQuota.snapshot!,
        reset_credits: {
          ...staleQuota.snapshot!.reset_credits!,
          usable_credits: [
            { expires_at: 1893456000, title: "Full reset (Weekly + 5 hr)" },
            { expires_at: 1894060800 },
          ],
        },
      },
    };
    mocks.accountQuota.mockResolvedValue(withTitles);
    mocks.refreshAccountQuota.mockResolvedValue(withTitles);
    render(<App />);

    expect(await screen.findByText("Personal")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.getByText("Last 30%")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset credits · person@example.com" });
    expect(within(dialog).getByText("2 available")).toBeInTheDocument();
    expect(within(dialog).getByText("Full reset (Weekly + 5 hr)")).toBeInTheDocument();
    expect(within(dialog).getByText("Usage limit reset")).toBeInTheDocument();
    expect(within(dialog).queryByText("Personal")).not.toBeInTheDocument();

    const [first] = within(dialog).getAllByRole("button", { name: /^Use the reset credit expiring/ });
    await userEvent.click(first!);
    expect(mocks.redeemResetCredit).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: /^Confirm the reset credit expiring/ })).toHaveTextContent("Confirm");

    await pastConfirmGuard();
    await userEvent.click(within(dialog).getByRole("button", { name: /^Confirm the reset credit expiring/ }));
    await waitFor(() =>
      expect(mocks.redeemResetCredit).toHaveBeenCalledWith("account-1", { expires_at: 1893456000, title: "Full reset (Weekly + 5 hr)" }),
    );
  });

  it("redeems the credit on the row the user picks, not the earliest", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    render(<App />);

    await confirmResetRow(1);

    await waitFor(() =>
      expect(mocks.redeemResetCredit).toHaveBeenCalledWith("account-1", { expires_at: 1894060800 }),
    );
  });

  it("adds the workspace to the reset title only when the email alone is ambiguous", async () => {
    const teamAccount = { ...chatAccount, id: "account-2", workspace_name: "Team" };
    mocks.listAccounts.mockResolvedValue([chatAccount, teamAccount]);
    mocks.accountQuota.mockImplementation(async (accountId: string) => ({ ...staleQuota, account_id: accountId }));
    render(<App />);

    const [details] = await screen.findAllByRole("button", { name: "Details" });
    await userEvent.click(details!);

    expect(await screen.findByRole("dialog", { name: "Reset credits · person@example.com · Personal" })).toBeInTheDocument();
  });

  it("shows the quota a reset returns on the card without a manual refresh", async () => {
    const quotaAfterReset: QuotaView = {
      account_id: "account-1",
      status: "fresh",
      snapshot: {
        ...staleQuota.snapshot!,
        fetched_at_unix_ms: Date.now(),
        reset_credits: {
          available_count: 1,
          nearest_expiry: 1894060800,
          details_available: true,
          can_redeem: true,
          usable_credits: [{ expires_at: 1894060800 }],
        },
      },
    };
    let redeemed = false;
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockImplementation(async () => (redeemed ? quotaAfterReset : staleQuota));
    mocks.redeemResetCredit.mockImplementation(async () => {
      redeemed = true;
      return { account_id: "account-1", outcome: "reset", quota: quotaAfterReset };
    });
    const { container } = render(<App />);

    expect(await screen.findByText("Personal")).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector(".credit-count strong")?.textContent).toBe("2"),
    );

    await confirmResetRow();

    await waitFor(() =>
      expect(container.querySelector(".credit-count strong")?.textContent).toBe("1"),
    );
    expect(mocks.refreshAccountQuota).not.toHaveBeenCalledWith("account-1", false);
  });

  it("names the account and the credit a reset used", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.redeemResetCredit.mockResolvedValue({
      account_id: "account-1",
      outcome: "reset",
      used_expires_at: 1893456000,
    });
    render(<App />);

    await confirmResetRow();

    expect(await screen.findByText(/^Used the reset credit expiring .+ for person@example.com\.$/)).toBeInTheDocument();
  });

  it("says when an account did not need a reset and no credit was used", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.redeemResetCredit.mockResolvedValue({ account_id: "account-1", outcome: "nothing_to_reset" });
    render(<App />);

    await confirmResetRow();

    expect(await screen.findByText("person@example.com doesn't need a reset right now. No credit was used.")).toBeInTheDocument();
  });

  it("explains an unconfirmed reset without claiming a credit was or was not used", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.redeemResetCredit.mockRejectedValue({ code: "result_unknown" });
    render(<App />);

    await confirmResetRow();

    expect(await screen.findByText(
      "GSwitch couldn't confirm whether the reset went through. The request is saved; retrying uses the same credit and won't use another.",
    )).toBeInTheDocument();
  });

  it("keeps the reset dialog closable while a full refresh runs", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.refreshAccountQuota.mockImplementation(() => new Promise(() => undefined));
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset credits · person@example.com" });

    expect(within(dialog).queryByText("Working…")).not.toBeInTheDocument();
    const close = within(dialog).getByRole("button", { name: /^Close / });
    expect(close).toBeEnabled();
    await userEvent.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows reset recovery after a reset request fails", async () => {
    let failed = false;
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.appSnapshot.mockImplementation(async () => ({
      storage: { status: "ready" },
      accounts: [chatAccount],
      pending_reset: failed ? { account_id: "account-1", discardable: false } : undefined,
      runtime: await mocks.runtimeInfo(),
      live: await mocks.liveAccount(),
    }));
    mocks.redeemResetCredit.mockImplementation(async () => {
      failed = true;
      throw "Codex App Server did not respond";
    });
    render(<App />);

    expect(await screen.findByText("Personal")).toBeInTheDocument();
    await confirmResetRow();

    expect(await screen.findByText("A reset hasn't been confirmed")).toBeInTheDocument();
  });

  it("shows the provider-supplied five-week free quota and reset time", async () => {
    const freeAccount = { ...chatAccount, plan_type: "free" };
    const resetAt = Math.floor(Date.now() / 1000) + 21 * 24 * 60 * 60;
    mocks.listAccounts.mockResolvedValue([freeAccount]);
    mocks.accountQuota.mockResolvedValue({
      account_id: freeAccount.id,
      status: "fresh",
      snapshot: {
        fetched_at_unix_ms: Date.now(),
        buckets: [{
          limit_id: "codex",
          kind: "codex",
          windows: [{ kind: "other", window_duration_mins: 50_400, remaining_percent: 100, used_percent: 0, resets_at: resetAt }],
        }],
      },
    });
    render(<App />);

    const card = (await screen.findByRole("heading", { name: "person@example.com" })).closest(".account-card");
    expect(card).toHaveTextContent("5 weeks");
    expect(card).toHaveTextContent("100%");
    const resetTime = card?.querySelector("time.quota-reset-time");
    expect(resetTime).toHaveTextContent(/\d+d/);
    expect(resetTime).toHaveAttribute("aria-label", expect.stringContaining("Resets"));
    expect(resetTime).toHaveAttribute("data-full-time", expect.any(String));
    expect(card).not.toHaveTextContent(/Resets \d/);
    expect(card).not.toHaveTextContent("5-hour");
    expect(card).not.toHaveTextContent("Reset time unavailable");
    expect(screen.getByRole("button", { name: "Start reset timer for person@example.com" })).toBeEnabled();
  });

  it("shows a short reset time with keyboard access to the exact date", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 5 * 60 * 60;
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({
      account_id: chatAccount.id,
      status: "fresh",
      snapshot: {
        fetched_at_unix_ms: Date.now(),
        buckets: [{
          limit_id: "codex",
          kind: "codex",
          windows: [{ kind: "five_hour", window_duration_mins: 300, remaining_percent: 50, used_percent: 50, resets_at: resetAt }],
        }],
      },
    });
    render(<App />);

    const card = (await screen.findByRole("heading", { name: "person@example.com" })).closest(".account-card");
    const resetTime = card?.querySelector("time.quota-reset-time");
    expect(resetTime).toHaveTextContent(/5h · \d{2}\/\d{2} \d{2}:\d{2}/);
    expect(resetTime).toHaveAttribute("aria-label", expect.stringContaining("Resets"));
    expect(resetTime).toHaveAttribute("tabindex", "0");
    expect(card).not.toHaveTextContent("Resets");
    expect(screen.getByRole("button", { name: "Start reset timer for person@example.com" })).toBeEnabled();
  });

  describe("quota countdown updates", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 5, 12, 10));
      mocks.listAccounts.mockResolvedValue([chatAccount]);
    });

    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    function quotaAt(resetsAt: number): QuotaView {
      return {
        account_id: chatAccount.id,
        status: "fresh",
        snapshot: {
          fetched_at_unix_ms: Date.now(),
          buckets: [{
            limit_id: "codex",
            kind: "codex",
            windows: [{ kind: "five_hour", window_duration_mins: 300, remaining_percent: 100, used_percent: 0, resets_at: resetsAt }],
          }],
        },
      };
    }

    it.each(["refresh", "wake"] as const)("synchronizes a new reset time after %s while preserving focus and one timer", async (action) => {
      const setInterval = vi.spyOn(window, "setInterval");
      const clearInterval = vi.spyOn(window, "clearInterval");
      const activeCountdownTimers = () => setInterval.mock.calls.flatMap(([, delay], index) => {
        const id = setInterval.mock.results[index]!.value as number;
        return delay === 60_000 && !clearInterval.mock.calls.some(([cleared]) => cleared === id) ? [id] : [];
      });
      mocks.accountQuota.mockResolvedValue(quotaAt(Date.now() / 1000 + 30 * 60));
      let resolveRefresh!: (quota: QuotaView) => void;
      mocks.refreshAccountQuota.mockImplementation(() => new Promise<QuotaView>((resolve) => { resolveRefresh = resolve; }));
      mocks.wakeOperation.mockResolvedValue({
        id: "wake-1",
        status: "completed",
        results: [{ account_id: chatAccount.id, result: "reply_received", request_state: "sent" }],
      });
      let view!: ReturnType<typeof render>;
      await act(async () => { view = render(<StrictMode><App /></StrictMode>); });
      const card = screen.getByRole("heading", { name: "person@example.com" }).closest(".account-card")!;
      const resetTime = card.querySelector<HTMLTimeElement>("time.quota-reset-time")!;
      expect(resetTime).toHaveTextContent(/^30m · /);
      expect(activeCountdownTimers()).toHaveLength(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `${action === "wake" ? "Start reset timer for" : "Refresh"} person@example.com` }));
      });
      if (action === "wake") {
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        const dialog = screen.getByRole("dialog", { name: "Reset timers" });
        await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Done" })); });
      }
      expect(mocks.refreshAccountQuota).toHaveBeenCalledTimes(1);
      resetTime.focus();
      const resetAt = Math.floor(Date.now() / 1000) + 5 * 60 * 60;
      await act(async () => { resolveRefresh(quotaAt(resetAt)); });

      expect(card.querySelector("time.quota-reset-time")).toBe(resetTime);
      expect(resetTime).toHaveFocus();
      expect(resetTime).toHaveTextContent(/^5h · /);
      expect(resetTime).toHaveAttribute("datetime", new Date(resetAt * 1000).toISOString());
      expect(activeCountdownTimers()).toHaveLength(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(resetTime).toHaveTextContent(/^4h 59m · /);
      expect(resetTime).toHaveFocus();
      view.unmount();
      expect(activeCountdownTimers()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("immediately marks a replacement reset time that has already passed", async () => {
      mocks.accountQuota.mockResolvedValue(quotaAt(Date.now() / 1000 + 30 * 60));
      await act(async () => { render(<App />); });
      const card = screen.getByRole("heading", { name: "person@example.com" }).closest(".account-card")!;
      const resetTime = card.querySelector<HTMLTimeElement>("time.quota-reset-time")!;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      const resetAt = Date.now() / 1000 - 1;
      mocks.refreshAccountQuota.mockResolvedValue(quotaAt(resetAt));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh person@example.com" })); });

      expect(card.querySelector("time.quota-reset-time")).toBe(resetTime);
      expect(resetTime).toHaveTextContent("Refresh to update");
      expect(resetTime).toHaveAttribute("datetime", new Date(resetAt * 1000).toISOString());
      expect(resetTime).toHaveAttribute("aria-label", expect.stringContaining("Refresh to update"));
    });
  });

  it("allows the same account to Wake again after an earlier completed request", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-1",
      status: "completed",
      results: [{ account_id: chatAccount.id, label: "Personal", result: "reply_received", request_state: "sent" }],
    });
    render(<App />);
    const wakeButton = await screen.findByRole("button", { name: "Start reset timer for person@example.com" });
    await userEvent.click(wakeButton);
    const firstDialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(firstDialog).findByText("Succeeded")).toBeInTheDocument();
    await userEvent.click(within(firstDialog).getByRole("button", { name: "Done" }));
    expect(wakeButton).toBeEnabled();
    await userEvent.click(wakeButton);
    expect(mocks.startWake).toHaveBeenCalledTimes(2);
  });

  it("does not show a past reset time as a current countdown", async () => {
    const resetAt = Math.floor(Date.now() / 1000) - 60;
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({
      account_id: chatAccount.id,
      status: "fresh",
      snapshot: {
        fetched_at_unix_ms: Date.now(),
        buckets: [{
          limit_id: "codex",
          kind: "codex",
          windows: [{ kind: "five_hour", window_duration_mins: 300, remaining_percent: 50, used_percent: 50, resets_at: resetAt }],
        }],
      },
    });
    render(<App />);

    const card = (await screen.findByRole("heading", { name: "person@example.com" })).closest(".account-card");
    expect(card?.querySelector("time.quota-reset-time")).toHaveTextContent("Refresh to update");
  });
  it("uses ChatGPT email as the primary identity and workspace as context", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "person@example.com" })).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh person@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start reset timer for person@example.com" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Switch to person@example.com" })).toBeEnabled();
  });

  it("names the plan on ChatGPT cards next to their actions", async () => {
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, plan_type: "team" }]);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Switch to person@example.com" })).toBeEnabled();
    expect(screen.getAllByText("Team").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start reset timer for person@example.com" })).toBeEnabled();
  });

  it("identifies the current account in its disabled action", async () => {
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, active: true }]);
    render(<App />);

    const current = await screen.findByRole("button", { name: "Current account: person@example.com" });
    expect(current).toBeDisabled();
  });

  it("keeps same-workspace ChatGPT accounts distinct by email", async () => {
    mocks.listAccounts.mockResolvedValue([
      chatAccount,
      { ...chatAccount, id: "account-2", email: "other@example.com" },
    ]);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "person@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "other@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to person@example.com" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Switch to other@example.com" })).toBeEnabled();
  });

  it("omits a duplicate workspace and falls back to a distinct legacy label", async () => {
    mocks.listAccounts.mockResolvedValue([
      { ...chatAccount, workspace_name: "person@example.com", label: "person@example.com" },
      { ...chatAccount, id: "account-2", workspace_name: undefined, label: "Legacy workspace" },
    ]);
    const { container } = render(<App />);

    expect(await screen.findAllByRole("heading", { name: "person@example.com" })).toHaveLength(2);
    expect(container.querySelectorAll(".account-copy p")).toHaveLength(1);
    expect(screen.getByText("Legacy workspace")).toBeInTheDocument();
  });

  it("keeps API-key cards label-first", async () => {
    mocks.listAccounts.mockResolvedValue([
      { id: "api-1", label: "Build key", kind: "api_key", active: false },
    ]);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Build key" })).toBeInTheDocument();
    expect(screen.getByText("Stored locally")).toBeInTheDocument();
  });

  it("requires a deliberate recovery of the original pending reset request", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.appSnapshot.mockImplementation(async () => ({
      storage: { status: "ready" },
      accounts: await mocks.listAccounts(),
      pending_reset: { account_id: "account-1", discardable: false },
      runtime: await mocks.runtimeInfo(),
      live: await mocks.liveAccount(),
    }));
    render(<App />);

    expect(await screen.findByText("A reset hasn't been confirmed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: "Unfinished reset" });
    expect(within(dialog).getByText(/The last reset for person@example.com wasn't confirmed/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Discard this record" })).not.toBeInTheDocument();
    expect(mocks.recoverPendingResetCredit).not.toHaveBeenCalled();
    expect(mocks.redeemResetCredit).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.recoverPendingResetCredit).toHaveBeenCalledOnce());
    expect(mocks.redeemResetCredit).not.toHaveBeenCalled();
  });

  it("discards an unrecoverable pending reset only after a second click", async () => {
    let pending: { account_id: string; discardable: boolean } | undefined = {
      account_id: "removed-account",
      discardable: true,
    };
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.discardPendingResetCredit.mockImplementation(async () => {
      pending = undefined;
    });
    mocks.appSnapshot.mockImplementation(async () => ({
      storage: { status: "ready" },
      accounts: await mocks.listAccounts(),
      pending_reset: pending,
      runtime: await mocks.runtimeInfo(),
      live: await mocks.liveAccount(),
    }));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: "Unfinished reset" });
    expect(within(dialog).getByText(/The last reset for a removed account/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Discard this record" }));
    expect(mocks.discardPendingResetCredit).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/can't confirm whether this request went through/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm discard" }));
    await waitFor(() => expect(mocks.discardPendingResetCredit).toHaveBeenCalledOnce());
    expect(await screen.findByText("The unfinished reset was discarded.")).toBeInTheDocument();
    expect(screen.queryByText("A reset hasn't been confirmed")).not.toBeInTheDocument();
  });

  it("keeps account actions available when a local quota projection cannot be read", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockRejectedValue(new Error("quota cache unavailable"));
    render(<App />);

    expect(await screen.findByText("Personal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to person@example.com" })).toBeEnabled();
    expect(screen.getAllByText("Not available")).toHaveLength(1);
  });

  it("saves the current account and refreshes its unknown quota in the background", async () => {
    mocks.liveAccount.mockResolvedValue({
      status: "unknown_account",
      credential_store: "file",
      message: "Save the current Codex account before replacing its credentials",
    });
    mocks.accountQuota.mockResolvedValue({ account_id: "account-1", status: "unknown" });
    mocks.saveCurrentAccount.mockImplementation(async () => {
      mocks.listAccounts.mockResolvedValue([chatAccount]);
      mocks.liveAccount.mockResolvedValue({
        status: "ready",
        credential_store: "file",
        account: { ...chatAccount, active: true },
      });
      return chatAccount;
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Save current account" }));
    await waitFor(() => expect(mocks.saveCurrentAccount).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", true));
    expect(await screen.findByText("person@example.com was saved safely.")).toBeInTheDocument();
  });

  it("coalesces a manual refresh with the background quota refresh", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ account_id: "account-1", status: "unknown" });
    let resolveRefresh: ((quota: QuotaView) => void) | undefined;
    mocks.refreshAccountQuota.mockImplementation(
      () => new Promise<QuotaView>((resolve) => { resolveRefresh = resolve; }),
    );
    render(<App />);

    await screen.findByText("Personal");
    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Refresh person@example.com" }));
    expect(mocks.refreshAccountQuota).toHaveBeenCalledOnce();

    mocks.accountQuota.mockResolvedValue(staleQuota);
    resolveRefresh?.(staleQuota);
    expect(await screen.findByText("Last 30%")).toBeInTheDocument();
  });

  it("shows how long ago each card's quota was read", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({
      ...staleQuota,
      status: "fresh",
      snapshot: { ...staleQuota.snapshot!, fetched_at_unix_ms: Date.now() - 3 * 60_000 },
    });
    render(<App />);

    expect(await screen.findByText("Updated 3 minutes ago")).toBeInTheDocument();
    expect(mocks.refreshAccountQuota).not.toHaveBeenCalled();
  });

  it("reads the current account again when the window regains focus after a minute", async () => {
    const active = { ...chatAccount, active: true };
    mocks.listAccounts.mockResolvedValue([active]);
    mocks.liveAccount.mockResolvedValue({ status: "ready", credential_store: "file", account: active });
    mocks.accountQuota.mockResolvedValue({
      ...staleQuota,
      status: "fresh",
      snapshot: { ...staleQuota.snapshot!, fetched_at_unix_ms: Date.now() - 90_000 },
    });
    render(<App />);

    expect(await screen.findByText("Updated 1 minute ago")).toBeInTheDocument();
    // Under two minutes old, so startup leaves the current account alone.
    expect(mocks.refreshAccountQuota).not.toHaveBeenCalled();

    fireEvent.focus(window);

    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", true));
  });

  it("starts a user's refresh without waiting behind automatic refreshes", async () => {
    const secondAccount = { ...chatAccount, id: "account-2", email: "other@example.com" };
    mocks.listAccounts.mockResolvedValue([chatAccount, secondAccount]);
    mocks.accountQuota.mockImplementation(async (accountId: string) => ({ account_id: accountId, status: "unknown" }));
    mocks.refreshAccountQuota.mockImplementation((accountId: string) =>
      accountId === "account-1"
        ? new Promise<QuotaView>(() => undefined)
        : Promise.resolve({ ...staleQuota, account_id: accountId, status: "fresh" }),
    );
    render(<App />);

    await screen.findByRole("heading", { name: "other@example.com" });
    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", true));
    expect(mocks.refreshAccountQuota).not.toHaveBeenCalledWith("account-2", true);

    await userEvent.click(screen.getByRole("button", { name: "Refresh other@example.com" }));

    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-2", true));
    expect(mocks.refreshAccountQuota).toHaveBeenCalledTimes(2);
  });

  it("uses the official sign-in refresh only after a read shows the saved sign-in needs it", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.refreshAccountQuota.mockImplementation(async (_accountId: string, background: boolean) => {
      if (background) {
        throw { code: "manual_refresh_needed" };
      }
      return { ...staleQuota, status: "fresh" };
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Refresh person@example.com" }));

    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", false));
    expect(mocks.refreshAccountQuota.mock.calls).toEqual([["account-1", true], ["account-1", false]]);
    expect(screen.queryByRole("button", { name: "Quota update failed for person@example.com" })).not.toBeInTheDocument();
  });

  it("shows full-refresh progress in the Accounts header without locking the workspace", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.refreshAccountQuota.mockImplementation(() => new Promise<QuotaView>(() => undefined));
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("button", { name: "Refreshing 0/1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start reset timer for person@example.com" })).toBeEnabled();
  });

  it("refreshes up to three accounts at once and continues after one quota failure", async () => {
    const accounts = Array.from({ length: 6 }, (_, index) => ({
      ...chatAccount,
      id: `account-${index + 1}`,
      email: `person${index + 1}@example.com`,
      label: `Personal ${index + 1}`,
      workspace_name: `Personal ${index + 1}`,
    }));
    mocks.listAccounts.mockResolvedValue(accounts);
    mocks.accountQuota.mockImplementation(async (accountId: string) => ({
      ...staleQuota,
      account_id: accountId,
      status: "fresh",
    }));
    let activeRequests = 0;
    let maximumConcurrentRequests = 0;
    mocks.refreshAccountQuota.mockImplementation(async (accountId: string) => {
      activeRequests += 1;
      maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
      try {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 2));
        if (accountId === "account-3") {
          throw new Error("provider unavailable");
        }
        return { ...staleQuota, account_id: accountId, status: "fresh" };
      } finally {
        activeRequests -= 1;
      }
    });
    render(<App />);

    await screen.findByRole("heading", { name: "person1@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledTimes(6));
    expect(maximumConcurrentRequests).toBe(3);
    expect(mocks.refreshAccountQuota.mock.calls.map(([id]) => id)).toEqual(
      accounts.map((account) => account.id),
    );
    expect(await screen.findByText("Could not refresh quota for 1 of your accounts. See the affected cards for their latest result.")).toBeInTheDocument();
    const failedCard = screen.getByRole("heading", { name: "person3@example.com" }).closest(".account-card");
    expect(failedCard).not.toHaveTextContent("Last result is stale");
    expect(within(failedCard as HTMLElement).getByRole("button", { name: "Quota update failed for person3@example.com" })).toBeInTheDocument();
    expect(failedCard).toHaveTextContent("GSwitch could not update this quota. Try again later.");
    expect(failedCard).toHaveTextContent("Last 30%");
    expect(mocks.appSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps failed quota values visibly historical and makes sign-in the primary action for a rejected sign-in", async () => {
    const copyEmail = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: copyEmail } });
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.refreshAccountQuota.mockRejectedValue({ code: "authentication" });
    render(<App />);

    const alert = await screen.findByRole("button", { name: "Quota update failed for person@example.com" });
    expect(alert).toHaveAttribute("aria-describedby", "quota-error-account-1");
    expect(screen.getByText("Last 30%")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.click(alert);
    const details = screen.getByRole("tooltip");
    expect(details).toHaveTextContent("This saved sign-in was rejected. Sign in to this account again.");
    expect(details).toHaveTextContent(/Last successful update:/);
    expect(within(details).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Quota could not be refreshed. The last result is shown when available.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("More actions for person@example.com"));
    await userEvent.click(screen.getByRole("button", { name: "Copy email" }));
    expect(copyEmail).toHaveBeenCalledWith("person@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(mocks.startOAuth).toHaveBeenCalledWith("account-1"));
    expect(mocks.openOAuth).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "Sign in again · person@example.com" })).toBeInTheDocument();
  });

  it("shows one compact warning for a failed cached reading and opens it by hover, click, or keyboard focus", async () => {
    const user = userEvent.setup();
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    mocks.refreshAccountQuota.mockRejectedValue({ code: "network", message: "private provider payload" });
    render(<App />);

    const warning = await screen.findByRole("button", { name: "Quota update failed for person@example.com" });
    const card = warning.closest("article")!;
    expect(within(card).getAllByRole("button", { name: /Quota update failed/ })).toHaveLength(1);
    expect(card).toHaveTextContent("Last 30%");
    expect(card).toHaveTextContent("Last 85%");
    expect(card).not.toHaveTextContent(/Stale|Last result is stale|private provider payload/);
    expect(card.querySelectorAll(".quota-meter small")).toHaveLength(0);
    expect(within(card).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(warning);
    expect(screen.getByRole("tooltip")).toHaveTextContent("The quota service could not be reached. Check your connection.");
    await user.unhover(warning);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.click(warning);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/Last successful update:/);
    await user.keyboard("{Escape}");
    expect(warning).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.click(warning);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.tab({ shift: true });
    expect(warning).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.click(screen.getByRole("heading", { name: "GSwitch Claude Tool" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    mocks.refreshAccountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    await user.click(screen.getByRole("button", { name: "Refresh person@example.com" }));
    expect(await within(card).findByText("30%")).toBeInTheDocument();
    expect(within(card).queryByText(/^Last \d/)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Quota update failed|Quota awaiting update/ })).not.toBeInTheDocument();
  });

  it("keeps quota details inside the window when the warning is near an edge or the page scrolls", async () => {
    vi.stubGlobal("innerWidth", 700);
    vi.stubGlobal("innerHeight", 520);
    let anchor = new DOMRect(665, 480, 22, 22);
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("quota-alert")) return anchor;
      if (this.classList.contains("quota-alert-tooltip")) {
        return new DOMRect(anchor.x + parseFloat(this.style.left || "-4"), anchor.y + parseFloat(this.style.top || "26"), 250, 130);
      }
      return originalRect.call(this);
    });
    try {
      mocks.listAccounts.mockResolvedValue([chatAccount]);
      mocks.accountQuota.mockResolvedValue(staleQuota);
      mocks.refreshAccountQuota.mockRejectedValue({ code: "network" });
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: "Quota update failed for person@example.com" }));
      const details = screen.getByRole("tooltip");
      let bounds = details.getBoundingClientRect();
      expect(bounds.bottom).toBeLessThan(anchor.top);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 8);
      expect(bounds.left).toBeGreaterThanOrEqual(8);

      anchor = new DOMRect(16, 16, 22, 22);
      fireEvent.scroll(window);
      bounds = details.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThan(anchor.bottom);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 8);
      expect(bounds.left).toBeGreaterThanOrEqual(8);

      anchor = new DOMRect(665, 480, 22, 22);
      fireEvent.resize(window);
      bounds = details.getBoundingClientRect();
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 8);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 8);
    } finally {
      measure.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("describes stale data without a failure as awaiting an update and omits an invalid last-success time", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({
      ...staleQuota,
      snapshot: { ...staleQuota.snapshot!, fetched_at_unix_ms: 0 },
    });
    mocks.refreshAccountQuota.mockImplementation(() => new Promise<QuotaView>(() => undefined));
    render(<App />);

    const warning = await screen.findByRole("button", { name: "Quota awaiting update for person@example.com" });
    expect(screen.queryByRole("button", { name: /Quota update failed/ })).not.toBeInTheDocument();
    await userEvent.click(warning);
    const details = screen.getByRole("tooltip");
    expect(details).toHaveTextContent("Quota awaiting update");
    expect(details).not.toHaveTextContent(/failed|Last successful update/);
    expect(screen.getByText("Last 30%")).toBeInTheDocument();
  });

  it("keeps a failed quota without a cache unknown and clears its warning after a successful retry", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.refreshAccountQuota.mockRejectedValueOnce({ code: "network" });
    render(<App />);

    const warning = await screen.findByRole("button", { name: "Quota update failed for person@example.com" });
    const card = warning.closest("article")!;
    expect(within(card).getByText("Not available")).toBeInTheDocument();
    expect(within(card).queryByText(/^Last \d/)).not.toBeInTheDocument();
    expect(card.querySelector(".quota-heading > strong")).toHaveTextContent("—");
    await userEvent.click(warning);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Last successful update");

    mocks.refreshAccountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh person@example.com" }));
    expect(await within(card).findByText("30%")).toBeInTheDocument();
    expect(within(card).getAllByRole("progressbar")).toHaveLength(2);
    expect(within(card).queryByRole("button", { name: /Quota update failed|Quota awaiting update/ })).not.toBeInTheDocument();
    expect(within(card).queryByText(/^Last \d/)).not.toBeInTheDocument();
  });

  it("does not turn a successful reading older than five minutes into stale data on reopening", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({
      ...staleQuota,
      status: "fresh",
      snapshot: { ...staleQuota.snapshot!, fetched_at_unix_ms: Date.now() - 10 * 60_000 },
    });
    render(<App />);

    expect(await screen.findByText("30%")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Quota update failed|Quota awaiting update/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Last 30%|Last result is stale|Stale/)).not.toBeInTheDocument();
    expect(mocks.refreshAccountQuota).not.toHaveBeenCalled();
  });

  it("shows a direct recovery action with the saved email and workspace", async () => {
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, sign_in_required: true }]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    render(<App />);
    const card = (await screen.findByRole("heading", { name: "person@example.com" })).closest("article");
    expect(card).toHaveTextContent("Sign in required");
    await userEvent.click(within(card as HTMLElement).getByRole("button", { name: "Sign in again" }));
    expect(mocks.startOAuth).toHaveBeenCalledWith("account-1");
    const dialog = await screen.findByRole("dialog", { name: "Sign in again · person@example.com" });
    expect(dialog).toHaveTextContent("Account: person@example.com");
    expect(dialog).toHaveTextContent("Workspace: Personal");
  });

  it("updates one account quota without reloading the account workspace", async () => {
    const secondAccount = { ...chatAccount, id: "account-2", email: "other@example.com" };
    mocks.listAccounts.mockResolvedValue([chatAccount, secondAccount]);
    mocks.accountQuota.mockImplementation(async (accountId: string) => ({
      ...staleQuota,
      account_id: accountId,
      status: "fresh",
    }));
    render(<App />);

    await screen.findByRole("heading", { name: "person@example.com" });
    expect(await screen.findByRole("heading", { name: "other@example.com" })).toBeInTheDocument();
    expect(mocks.appSnapshot).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh person@example.com" }));

    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", true));
    expect(mocks.appSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "person@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "other@example.com" })).toBeInTheDocument();
  });

  it("keeps unrelated account actions interactive during a point refresh", async () => {
    const secondAccount = { ...chatAccount, id: "account-2", email: "other@example.com" };
    mocks.listAccounts.mockResolvedValue([chatAccount, secondAccount]);
    mocks.accountQuota.mockImplementation(async (accountId: string) => ({
      ...staleQuota,
      account_id: accountId,
      status: "fresh",
      snapshot: accountId === "account-2" ? {
        ...staleQuota.snapshot!,
        buckets: [{
          ...staleQuota.snapshot!.buckets[0]!,
          windows: staleQuota.snapshot!.buckets[0]!.windows.map((window) => window.kind === "five_hour"
            ? { ...window, remaining_percent: 0, used_percent: 100 }
            : window),
        }],
      } : staleQuota.snapshot,
    }));
    let resolveRefresh: ((quota: QuotaView) => void) | undefined;
    mocks.refreshAccountQuota.mockImplementation(
      () => new Promise<QuotaView>((resolve) => { resolveRefresh = resolve; }),
    );
    render(<App />);

    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh person@example.com" }));
    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", true));

    expect(screen.getByRole("button", { name: "Refresh person@example.com" })).toBeDisabled();
    const otherWake = screen.getByRole("button", { name: "Start reset timer for other@example.com" });
    expect(otherWake).toBeEnabled();
    await userEvent.click(otherWake);
    await waitFor(() => expect(mocks.startWake).toHaveBeenCalledWith("account-2", false));

    resolveRefresh?.(staleQuota);
  });

  it("keeps account actions available when the live Codex account cannot be identified", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ account_id: "account-1", status: "unknown" });
    mocks.refreshAccountQuota.mockRejectedValue({ code: "codex_account_unknown" });
    render(<App />);

    expect(await screen.findByText(/Codex is running, but its account cannot be identified/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to person@example.com" })).toBeEnabled();
  });

  it.each([
    ["operation_busy", /Another GSwitch operation is in progress/],
    ["codex_open", /Quit the other Codex session/],
    ["account_needs_sign_in", /needs sign-in again/],
    ["file_store_required", /Enable file-backed Codex credentials/],
    ["credentials_changed", /Codex credentials changed during the switch/],
    ["recovery_required", /Complete the protected switch recovery/],
    ["codex_app_server_unavailable", /could not start the Codex CLI service/],
    ["codex_config_unavailable", /could not finish checking Codex settings/],
    ["codex_config_cleanup_failed", /could not finish the local Codex check/],
    ["current_credential_unreadable", /could not read the current Codex sign-in/],
    ["current_account_not_saved", /Save the current Codex account/],
    ["local_verification_failed", /could not read its local account state/],
    ["target_check_unavailable", /could not check .* with ChatGPT/],
    ["target_workspace_mismatch", /do not match the selected workspace/],
    ["post_write_verification_failed", /restored the previous Codex account/],
    ["verification_failed", /could not verify/],
  ] satisfies Array<[SwitchFailureCode, RegExp]>)(
    "shows an actionable %s switch failure for the selected account",
    async (code, message) => {
      mocks.listAccounts.mockResolvedValue([chatAccount]);
      mocks.switchAccount.mockRejectedValue({ code });
      render(<App />);

      await userEvent.click(
        await screen.findByRole("button", { name: "Switch to person@example.com" }),
      );
      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent(message);
      expect(notice).toHaveTextContent("person@example.com");
    },
  );

  it("uses the account label in a structured switch failure when email is unavailable", async () => {
    const account = { ...chatAccount, email: undefined, label: "Fallback account" };
    mocks.listAccounts.mockResolvedValue([account]);
    mocks.switchAccount.mockRejectedValue({ code: "verification_failed" });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Switch to Fallback account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not verify Fallback account");
  });

  // Whether each failure makes Sign in again the card's primary action. The
  // account menu must offer it after every failure, so recovery never depends
  // on GSwitch having diagnosed the failure correctly.
  const switchFailurePromotesSignIn = {
    operation_busy: false,
    codex_open: false,
    account_needs_sign_in: true,
    file_store_required: false,
    credentials_changed: false,
    recovery_required: false,
    local_verification_failed: false,
    codex_app_server_unavailable: false,
    codex_config_unavailable: false,
    codex_config_cleanup_failed: false,
    current_credential_unreadable: false,
    current_account_not_saved: false,
    target_check_unavailable: false,
    target_workspace_mismatch: false,
    post_write_verification_failed: false,
    verification_failed: false,
  } satisfies Record<SwitchFailureCode, boolean>;

  const quotaFailurePromotesSignIn = {
    operation_busy: false,
    codex_account_unknown: false,
    authentication: true,
    manual_refresh_needed: false,
    rate_limited: false,
    network: false,
    service: false,
    invalid_response: false,
    identity_mismatch: false,
    unavailable: false,
  } satisfies Record<QuotaRefreshFailureCode, boolean>;

  async function expectSignInAgainReachable(promoted: boolean) {
    const card = screen.getByRole("heading", { name: "person@example.com" }).closest("article") as HTMLElement;
    expect(within(card).queryAllByRole("button", { name: "Sign in again" })).toHaveLength(promoted ? 1 : 0);
    expect(within(card).queryAllByRole("button", { name: "Switch to person@example.com" })).toHaveLength(promoted ? 0 : 1);

    await userEvent.click(within(card).getByRole("button", { name: "More actions for person@example.com" }));
    const menu = card.querySelector<HTMLElement>(".card-menu-popover")!;
    await userEvent.click(within(menu).getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(mocks.startOAuth).toHaveBeenCalledWith("account-1"));
    expect(await screen.findByRole("dialog", { name: "Sign in again · person@example.com" })).toBeInTheDocument();
  }

  it.each(Object.entries(switchFailurePromotesSignIn) as Array<[SwitchFailureCode, boolean]>)(
    "keeps Sign in again reachable after a %s switch failure",
    async (code, promoted) => {
      mocks.listAccounts.mockResolvedValue([chatAccount]);
      mocks.switchAccount.mockRejectedValue({ code });
      render(<App />);

      await userEvent.click(await screen.findByRole("button", { name: "Switch to person@example.com" }));
      await screen.findByRole("alert");
      await expectSignInAgainReachable(promoted);
    },
  );

  it.each(Object.entries(quotaFailurePromotesSignIn) as Array<[QuotaRefreshFailureCode, boolean]>)(
    "keeps Sign in again reachable after a %s quota failure",
    async (code, promoted) => {
      mocks.listAccounts.mockResolvedValue([chatAccount]);
      mocks.accountQuota.mockResolvedValue(staleQuota);
      mocks.refreshAccountQuota.mockRejectedValue({ code });
      render(<App />);

      await screen.findByRole("button", { name: "Quota update failed for person@example.com" });
      await expectSignInAgainReachable(promoted);
    },
  );

  it("does not offer browser sign-in for an API-key account", async () => {
    mocks.listAccounts.mockResolvedValue([{ id: "api-1", label: "Key", kind: "api_key", active: false }]);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "More actions for Key" }));
    expect(screen.getByRole("button", { name: "Remove Key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it("updates the active account without reloading the workspace or adding a banner", async () => {
    const currentAccount: AccountView = {
      id: "account-2",
      label: "Current",
      kind: "chat_gpt",
      email: "current@example.com",
      active: true,
    };
    const activatedTarget = { ...chatAccount, active: true };
    mocks.listAccounts
      .mockResolvedValueOnce([currentAccount, chatAccount])
      .mockResolvedValue([{ ...currentAccount, active: false }, activatedTarget]);
    mocks.liveAccount
      .mockResolvedValueOnce({
        status: "ready",
        credential_store: "file",
        account: currentAccount,
      })
      .mockResolvedValue({
        status: "ready",
        credential_store: "file",
        account: activatedTarget,
      });
    mocks.switchAccount.mockResolvedValue({ account: activatedTarget });
    const { container } = render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Switch to person@example.com" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Current account: person@example.com" })).toBeDisabled());
    expect(mocks.appSnapshot).toHaveBeenCalledOnce();
    expect(screen.queryByText("person@example.com is now the active Codex account.")).not.toBeInTheDocument();
    const cards = container.querySelectorAll<HTMLElement>(".account-card");
    expect(within(cards[0]!).getByText("person@example.com")).toBeInTheDocument();
  });

  it("lets a switch complete while startup quota refresh is still pending", async () => {
    const target = { ...chatAccount, id: "account-2", email: "other@example.com" };
    mocks.listAccounts.mockResolvedValue([chatAccount, target]);
    mocks.accountQuota.mockImplementation(async (id: string) => ({ account_id: id, status: "unknown" }));
    mocks.refreshAccountQuota.mockImplementation(() => new Promise<QuotaView>(() => undefined));
    mocks.switchAccount.mockResolvedValue({ account: { ...target, active: true } });
    render(<App />);

    await waitFor(() => expect(mocks.refreshAccountQuota).toHaveBeenCalledWith("account-1", true));
    await userEvent.click(screen.getByRole("button", { name: "Switch to other@example.com" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Current account: other@example.com" })).toBeDisabled());
    expect(mocks.appSnapshot).toHaveBeenCalledOnce();
  });

  it("lets the user cancel a browser OAuth flow", async () => {
    mocks.cancelOAuth.mockImplementation(async () => {
      mocks.oauthStatus.mockResolvedValue({ status: "cancelled" });
    });
    render(<App />);
    await screen.findByRole("heading", { name: "0 saved accounts" });

    await userEvent.click(screen.getByRole("button", { name: /^Add account$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Codex account" });
    await userEvent.click(within(dialog).getByRole("button", { name: /^Sign in / }));
    expect(await screen.findByText("Finish sign-in in your browser")).toBeInTheDocument();
    expect(mocks.openOAuth).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(mocks.cancelOAuth).toHaveBeenCalledWith("login-1"));
    expect(await screen.findByText("Sign-in cancelled")).toBeInTheDocument();
  });

  it("keeps a browser sign-in pending after a temporary status read failure", async () => {
    mocks.oauthStatus
      .mockRejectedValueOnce(new Error("temporary status outage"))
      .mockResolvedValue({ status: "complete", account: chatAccount });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Add account$/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Sign in / }));

    expect(await screen.findByText(/cannot check the sign-in result right now/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add a Codex account" })).toBeInTheDocument();
    expect(mocks.startOAuth).toHaveBeenCalledOnce();
    expect(mocks.cancelOAuth).not.toHaveBeenCalled();
    expect(await screen.findByText("person@example.com was imported safely.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(mocks.oauthStatus).toHaveBeenCalledTimes(2);
  });

  it("finishes a completed browser sign-in and retries saving without a new authorization", async () => {
    mocks.oauthStatus
      .mockResolvedValueOnce({ status: "finishing" })
      .mockResolvedValueOnce({ status: "failed", code: "save_failed", retryable: true })
      .mockResolvedValue({ status: "complete", account: { ...chatAccount, needs_apply: true }, cleanup_warning: false });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^Add account$/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Sign in / }));
    expect(await screen.findByText("Finishing sign-in…")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Retry saving" }));
    expect(mocks.retryOAuth).toHaveBeenCalledWith("login-1");
    expect(mocks.startOAuth).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Sign-in saved. Switch to this account/)).toBeInTheDocument();
  });

  it("removes a non-current saved account while keeping the identity and inline retry error clear", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.removeSavedAccount.mockRejectedValueOnce(
      new Error("Another GSwitch operation is already in progress"),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });

    await userEvent.click(screen.getByLabelText("More actions for person@example.com"));
    await userEvent.click(screen.getByRole("button", { name: "Remove person@example.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove person@example.com?" });
    expect(within(dialog).getByText("person@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("Personal")).toBeInTheDocument();
    expect(within(dialog).getByText(/removes only the copy saved in GSwitch/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Another GSwitch operation is in progress. Wait for it to finish, then try again.",
    );
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(mocks.removeSavedAccount).toHaveBeenCalledWith("account-1");
  });

  it("explains that an account with an unfinished reset cannot be removed yet", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.removeSavedAccount.mockRejectedValueOnce(
      "This account has an unfinished reset; resolve it before removing the account",
    );
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });

    await userEvent.click(screen.getByLabelText("More actions for person@example.com"));
    await userEvent.click(screen.getByRole("button", { name: "Remove person@example.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove person@example.com?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This account has an unfinished reset. Resolve it before removing the account.",
    );
  });

  it("keeps the current account protected from removal", async () => {
    const activeAccount = { ...chatAccount, active: true };
    mocks.listAccounts.mockResolvedValue([activeAccount]);
    mocks.liveAccount.mockResolvedValue({
      status: "ready",
      credential_store: "file",
      account: activeAccount,
    });
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    render(<App />);

    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByLabelText("More actions for person@example.com"));
    expect(screen.getByRole("button", { name: "Remove person@example.com" })).toBeDisabled();
    expect(mocks.removeSavedAccount).not.toHaveBeenCalled();
  });

  it("closes an account menu on an outside press, Escape, or another menu", async () => {
    const otherAccount = { ...chatAccount, id: "account-2", email: "other@example.com" };
    mocks.listAccounts.mockResolvedValue([chatAccount, otherAccount]);
    const user = userEvent.setup();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "More actions for person@example.com" });
    const menuItem = () => screen.queryByRole("button", { name: "Remove person@example.com" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(menuItem()).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menuItem()).toBeInTheDocument();
    await user.click(screen.getByRole("heading", { name: "2 saved accounts" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(menuItem()).not.toBeInTheDocument();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(menuItem()).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "More actions for other@example.com" }));
    expect(menuItem()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove other@example.com" })).toBeInTheDocument();
  });

  it("closes an account menu when keyboard focus leaves it or an action is chosen", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    // userEvent.setup() installs its own clipboard, so stub it afterwards.
    const user = userEvent.setup();
    const copyEmail = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: copyEmail } });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "More actions for person@example.com" });

    trigger.focus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Copy email" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Sign in again" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Remove person@example.com" })).toHaveFocus();
    await user.tab();
    expect(screen.queryByRole("button", { name: "Copy email" })).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Copy email" }));
    expect(copyEmail).toHaveBeenCalledWith("person@example.com");
    expect(screen.queryByRole("button", { name: "Copy email" })).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Remove person@example.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove person@example.com?" });
    expect(screen.queryByRole("button", { name: "Copy email" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });

  it("keeps Wake visible until completion and shows only this operation's result", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    let resolveWake: ((result: { id: string; status: "completed"; results: Array<{ account_id: string; label: string; result: "failed"; request_state: "not_sent"; message: string }> }) => void) | undefined;
    mocks.wakeOperation.mockImplementation(() => new Promise((resolve) => { resolveWake = resolve; }));
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });

    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(within(dialog).queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Close Reset timers/ })).toBeDisabled();
    expect(within(dialog).getByText("Starting…")).toBeInTheDocument();
    expect(within(dialog).getByText("Processed 0")).toBeInTheDocument();
    expect(within(dialog).queryByText("Working…")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Sending a Codex request/)).not.toBeInTheDocument();
    await waitFor(() => expect(resolveWake).toBeDefined());
    resolveWake?.({
      id: "wake-all",
      status: "completed",
      results: [{ account_id: "account-1", label: "Legacy label", result: "failed", request_state: "not_sent", message: "raw provider error text" }],
    });
    const resultDialog = dialog;
    expect(await within(resultDialog).findByText("person@example.com")).toBeInTheDocument();
    expect(within(resultDialog).getByText("Personal")).toBeInTheDocument();
    expect(within(resultDialog).getByText("Not sent · Could not start the reset timer.")).toBeInTheDocument();
    expect(within(resultDialog).getByText(/1 failed/)).toBeInTheDocument();
    expect(within(resultDialog).queryByText("raw provider error text")).not.toBeInTheDocument();
    await userEvent.click(within(resultDialog).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: "Start all reset timers" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Last result" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Reset timers" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    expect(await screen.findByRole("dialog", { name: "Reset timers" })).toBeInTheDocument();
    expect(mocks.startWakeAll).toHaveBeenCalledTimes(2);
  });

  it("distinguishes confirmed replies, rejected requests and uncertain delivery", async () => {
    const saved = [chatAccount,
      { ...chatAccount, id: "account-2", email: "other@example.com" },
      { ...chatAccount, id: "account-3", email: "third@example.com" }];
    mocks.listAccounts.mockResolvedValue(saved);
    mocks.accountQuota.mockImplementation(async (id: string) => ({ ...staleQuota, account_id: id, status: "fresh" }));
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-all",
      status: "completed",
      results: [
        { account_id: "account-1", label: "Personal", result: "reply_received", request_state: "sent" },
        { account_id: "account-2", label: "Other", result: "rate_limited", request_state: "sent" },
        { account_id: "account-3", label: "Third", result: "sent_not_confirmed", request_state: "may_have_sent" },
      ],
    });
    render(<App />);
    await screen.findByRole("heading", { name: "3 saved accounts" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText("1 succeeded · 1 unconfirmed · 1 failed")).toBeInTheDocument();
    expect(within(dialog).getByText("Unconfirmed. The request may have been sent.")).toBeInTheDocument();
    expect(within(dialog).getByText("Succeeded")).toBeInTheDocument();
    expect(within(dialog).getByText("Limit reached. Try later.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Request sent/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Retry reset timer/ })).not.toBeInTheDocument();
  });

  it("shows stopped accounts without implying their requests were sent", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-all",
      status: "cancelled",
      results: [{ account_id: "account-1", label: "Personal", result: "cancelled", request_state: "not_sent" }],
    });
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText("Stopped")).toBeInTheDocument();
    expect(within(dialog).getByText("1 not run")).toBeInTheDocument();
    expect(within(dialog).getByText("Not run.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Not sent · Not run/)).not.toBeInTheDocument();
  });

  it("shows a sanitized Wake request failure and its HTTP status", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-all",
      status: "completed",
      results: [{ account_id: "account-1", label: "Personal", result: "invalid_request", request_state: "sent", http_status: 400, message: "private provider details" }],
    });
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText("Request parameters were rejected. (HTTP 400)")).toBeInTheDocument();
    expect(within(dialog).queryByText(/private provider details/)).not.toBeInTheDocument();
  });

  it("shows concise Wake results for a confirmed reply and a sign-in failure", async () => {
    mocks.listAccounts.mockResolvedValue([
      chatAccount,
      { ...chatAccount, id: "account-2", email: "other@example.com" },
    ]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-all",
      status: "completed",
      results: [
        { account_id: "account-1", label: "Personal", result: "reply_received", request_state: "sent" },
        { account_id: "account-2", label: "Other", result: "needs_sign_in", request_state: "not_sent" },
      ],
    });
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText("1 succeeded · 1 failed")).toBeInTheDocument();
    expect(within(dialog).getByText("Succeeded")).toBeInTheDocument();
    expect(within(dialog).getByText("Not sent · Sign in again.")).toBeInTheDocument();
  });

  it("offers a manual older-model retry only after a definite model rejection", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.startWake.mockResolvedValue({ operation_id: "wake-alternate" });
    mocks.wakeOperation.mockImplementation(async (operationId: string) => ({
      id: operationId,
      status: "completed",
      alternate_model: operationId === "wake-alternate",
      results: [{
        account_id: "account-1",
        label: "Personal",
        result: "model_unavailable",
        request_state: "sent",
      }],
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText("GPT-6 Luna unavailable.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry reset timer for person@example.com with GPT-5.6 Luna" }));
    expect(mocks.startWake).toHaveBeenCalledWith("account-1", true);
    await within(dialog).findByText("GPT-5.6 Luna unavailable.");
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: /Retry reset timer/ })).not.toBeInTheDocument());
  });

  it("retains a running Wake operation when a status read briefly fails", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.wakeOperation
      .mockRejectedValueOnce(new Error("temporary status outage"))
      .mockResolvedValue({
        id: "wake-all",
        status: "completed",
        results: [{ account_id: "account-1", label: "Personal", result: "reply_received", request_state: "sent" }],
      });
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));

    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText(/cannot check the reset timer result right now/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(await within(dialog).findByText("1 succeeded", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(mocks.startWakeAll).toHaveBeenCalledOnce();
    expect(mocks.wakeOperation).toHaveBeenCalledTimes(2);
  });

  it("reports one reply per account even when all five have available quota", async () => {
    const saved = Array.from({ length: 5 }, (_, index) => ({
      ...chatAccount,
      id: `account-${index + 1}`,
      email: `person${index + 1}@example.com`,
    }));
    mocks.listAccounts.mockResolvedValue(saved);
    mocks.accountQuota.mockImplementation(async (id: string) => ({ ...staleQuota, account_id: id, status: "fresh" }));
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-all",
      status: "completed",
      results: saved.map((account) => ({ account_id: account.id, label: account.label, result: "reply_received", request_state: "sent" })),
    });
    render(<App />);
    await screen.findByRole("heading", { name: "5 saved accounts" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    expect(await within(dialog).findByText("5 succeeded")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Succeeded")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Start all reset timers" })).toBeEnabled();
  });

  it("opens the affected saved account from a Wake sign-in failure", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue({ ...staleQuota, status: "fresh" });
    mocks.wakeOperation.mockResolvedValue({
      id: "wake-all", status: "completed",
      results: [{ account_id: chatAccount.id, label: chatAccount.label, result: "needs_sign_in", request_state: "sent" }],
    });
    render(<App />);
    await screen.findByRole("heading", { name: "person@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Start all reset timers" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset timers" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Sign in again" }));
    expect(mocks.startOAuth).toHaveBeenCalledWith(chatAccount.id);
    expect(await screen.findByRole("dialog", { name: "Sign in again · person@example.com" })).toBeInTheDocument();
  });

  it("shows a per-operation Wake surface instead of silently running in the background", async () => {
    mocks.listAccounts.mockResolvedValue([chatAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    render(<App />);
    await screen.findByText("Personal");

    await userEvent.click(screen.getByRole("button", { name: /^Start all reset timers$/ }));
    expect(await screen.findByRole("dialog", { name: "Reset timers" })).toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(mocks.startWakeAll).toHaveBeenCalledOnce();
  });

  it("selects saved accounts, wakes only selected ChatGPT accounts, and exports through a warning", async () => {
    const apiAccount: AccountView = {
      id: "api-1",
      label: "Key",
      kind: "api_key",
      active: false,
    };
    mocks.listAccounts.mockResolvedValue([chatAccount, apiAccount]);
    mocks.accountQuota.mockResolvedValue(staleQuota);
    render(<App />);
    await screen.findByText("Personal");

    const heading = screen.getByRole("heading", { name: "2 saved accounts" });
    expect(heading.closest("section")?.querySelector(".eyebrow")).not.toBeInTheDocument();
    const selectButton = screen.getByRole("button", { name: "Select accounts" });
    expect(selectButton).toHaveClass("button-secondary", "section-select-button");
    expect(selectButton).toHaveAttribute("aria-pressed", "false");
    selectButton.focus();
    expect(selectButton).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
    }
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    const accountChoice = screen.getByRole("checkbox", { name: "Select person@example.com" });
    expect(accountChoice).not.toBeChecked();
    await userEvent.click(accountChoice);
    await userEvent.click(screen.getByRole("button", { name: "Start reset timer" }));
    await waitFor(() => expect(mocks.startWakeSelected).toHaveBeenCalledWith(["account-1"]));
    expect(await screen.findByRole("dialog", { name: "Reset timers" })).toBeInTheDocument();
    const wakeDialog = await screen.findByRole("dialog", { name: "Reset timers" });
    await userEvent.click(await within(wakeDialog).findByRole("button", { name: "Done" }));

    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const exportDialog = await screen.findByRole("dialog", { name: "Export 1 account" });
    expect(within(exportDialog).getByText(/The exported file isn't encrypted/)).toBeInTheDocument();
    await userEvent.click(within(exportDialog).getByRole("button", { name: "Export" }));
    expect(mocks.exportAccounts).not.toHaveBeenCalled();
    await pastConfirmGuard();
    await userEvent.click(within(exportDialog).getByRole("button", { name: "Confirm export" }));
    await waitFor(() => expect(mocks.exportAccounts).toHaveBeenCalledWith(["account-1"]));
    expect(await screen.findByText("Export complete: 1 selected. Keep this unencrypted file private.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Select accounts" })).toHaveAttribute("aria-pressed", "false");
  });

  it("offers a signed update once and keeps Later local to the current session", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    updaterMocks.check.mockResolvedValue({ version: "1.0.2" });
    render(<App />);

    expect(await screen.findByText("GSwitch 1.0.2 is available")).toBeInTheDocument();
    expect(screen.queryByText(/signed update never touches/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText("GSwitch 1.0.2 is available")).not.toBeInTheDocument();
  });

  it("uses the release page fallback for a Debian package without touching accounts", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    updaterMocks.check.mockResolvedValue({ version: "1.0.2" });
    mocks.updateDelivery.mockResolvedValue("release_download");
    render(<App />);

    expect(await screen.findByText("This Linux package updates from the GSwitch release page.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open release" }));
    await waitFor(() => expect(mocks.openLatestRelease).toHaveBeenCalledOnce());
    expect(mocks.switchAccount).not.toHaveBeenCalled();
  });

  it("switches palette and mode in Settings and remembers them", async () => {
    window.localStorage.clear();
    delete document.documentElement.dataset.palette;
    delete document.documentElement.dataset.scheme;
    render(<App />);

    await goTo("Settings");
    const appearance = await screen.findByRole("region", { name: "Appearance" });
    const palettes = within(appearance).getByRole("group", { name: "Palette" });
    const modes = within(appearance).getByRole("group", { name: "Mode" });
    expect(within(palettes).getByRole("button", { name: /Claude Code/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(palettes).getByRole("button", { name: /Codex/ }));
    expect(document.documentElement.dataset.palette).toBe("codex");
    expect(window.localStorage.getItem("gswitch.palette")).toBe("codex");
    expect(within(palettes).getByRole("button", { name: /Codex/ })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(within(modes).getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.scheme).toBe("dark");

    // The default palette and following the system leave no attribute.
    await userEvent.click(within(palettes).getByRole("button", { name: /Claude Code/ }));
    await userEvent.click(within(modes).getByRole("button", { name: "System" }));
    expect(document.documentElement.dataset.palette).toBeUndefined();
    expect(document.documentElement.dataset.scheme).toBeUndefined();
    expect(window.localStorage.getItem("gswitch.scheme")).toBe("system");
  });

  it("checks for updates when asked and always answers", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    updaterMocks.check.mockResolvedValue(null);
    mocks.appVersion.mockResolvedValue({ version: "1.2.0", dev: false });
    render(<App />);

    expect(await screen.findByText("v1.2.0")).toHaveAttribute("title", "Version 1.2.0");
    await goTo("Settings");
    expect(within(await screen.findByRole("region", { name: "Updates" })).getByText("Version 1.2.0")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("GSwitch Claude Tool 1.2.0 is up to date.")).toBeInTheDocument();

    updaterMocks.check.mockRejectedValue("GITHUB_SIGN_IN_MISSING");
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/Git has no saved GitHub sign-in/)).toBeInTheDocument();

    updaterMocks.check.mockResolvedValue({ version: "1.1.1" });
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("GSwitch 1.1.1 is available")).toBeInTheDocument();
  });

  it("waits to update while Claude's delegated Codex work is running", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const downloadAndInstall = vi.fn().mockRejectedValue("INVOKE_BUSY");
    updaterMocks.check.mockResolvedValue({ version: "1.0.2", downloadAndInstall });
    mocks.updateDelivery.mockResolvedValue("installer_exits");
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Update GSwitch" }));
    expect(await screen.findByText(/Claude's delegated Codex work is running\. Update after it finishes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update GSwitch" })).toBeEnabled();
  });

  // Added by Light505: rollback requires confirmation and shares update progress/guards.
  it("confirms the rollback target before installing and blocks other checks", async () => {
    const downloadAndInstall = vi.fn().mockRejectedValue("INVOKE_BUSY");
    updaterMocks.checkRollback.mockResolvedValue({ version: "1.7.0", downloadAndInstall });
    mocks.updateDelivery.mockResolvedValue("installer_exits");
    render(<App />);
    await goTo("Settings");
    await userEvent.click(await screen.findByRole("button", { name: "Roll back to previous version" }));
    expect(await screen.findByText("Reinstall GSwitch Claude Tool v1.7.0?")).toBeInTheDocument();
    expect(screen.getByText("Your accounts and settings stay; settings added after v1.7.0 may be ignored by the older version.")).toBeInTheDocument();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Reinstall GSwitch Claude Tool" }));
    expect(await screen.findByText(/Claude's delegated Codex work is running/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reinstall GSwitch Claude Tool" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });

  it("reports when no previous release exists", async () => {
    updaterMocks.checkRollback.mockRejectedValue("NO_PREVIOUS_RELEASE");
    render(<App />);
    await goTo("Settings");
    await userEvent.click(await screen.findByRole("button", { name: "Roll back to previous version" }));
    expect(await screen.findByText("No previous published version is available.")).toBeInTheDocument();
  });

  it("restarts only after a macOS or AppImage update finishes", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    updaterMocks.check.mockResolvedValue({ version: "1.0.2", downloadAndInstall });
    mocks.updateDelivery.mockResolvedValue("relaunch_required");
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Update GSwitch" }));
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledOnce());
    expect(await screen.findByText("Restart GSwitch to finish updating")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Restart now" }));
    expect(updaterMocks.relaunch).toHaveBeenCalledOnce();
  });
});

describe("Invoke Mode", () => {
  const apiKeyAccount: AccountView = { id: "api-1", label: "Key", kind: "api_key", active: false };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
    prepareDefaults();
    mocks.listAccounts.mockResolvedValue([chatAccount, apiKeyAccount]);
  });

  it("keeps Claude only as the plain switcher and says so on Home", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: "How your setup works" }))
      .toHaveTextContent("Claude alone: Claude Code does all the work. Codex is not used.");
    await goTo("Accounts");
    expect((await screen.findAllByText("person@example.com")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Account mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Codex helper settings/ })).not.toBeInTheDocument();
  });

  it("explains the saved setup on Home and opens Claude Code from Change", async () => {
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, invoke_allowed: true }, apiKeyAccount]);
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: { ...claudeSetup(true), setup: "router" }, allowed_invocation_profiles: [] });
    render(<App />);
    const card = await screen.findByRole("region", { name: "How your setup works" });
    expect(card).toHaveTextContent(
      "Automatic team: Claude Code plans each task and checks the result. Codex writes the code first; if it fails, a stronger model takes over. Codex may use 1 of your 1 accounts and switches when one runs out.",
    );
    await userEvent.click(within(card).getByRole("button", { name: "Change" }));
    const panel = await screen.findByRole("region", { name: "Claude Code" });
    expect(within(panel).getByRole("button", { name: /^Automatic team/ })).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("gswitch.section")).toBe("claude-code");
  });

  it("shows the five newest Activity events on Home and links to Results", async () => {
    mocks.activity.mockResolvedValue([3, 0, 6, 1, 5, 2, 4].map((minutes) => ({
      at: Date.now() - minutes * 60_000, kind: "task_started", task: `t${minutes}`, model: `m${minutes}`, effort: "low", write: false, cwd: "/work",
    })));
    render(<App />);
    const recent = await screen.findByRole("region", { name: "Recent" });
    await waitFor(() => expect(within(recent).getAllByRole("listitem")).toHaveLength(5));
    expect(within(recent).getAllByRole("listitem").map((item) => item.textContent?.match(/on (m\d)/)?.[1]))
      .toEqual(["m0", "m1", "m2", "m3", "m4"]);
    await userEvent.click(within(recent).getByRole("button", { name: "See all in Results" }));
    const results = await screen.findByRole("region", { name: "Activity" });
    await waitFor(() => expect(results.querySelectorAll(".activity-list > li")).toHaveLength(7));
  });

  it("enables Invoke through a saved setup and offers per-account eligibility", async () => {
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Claude with Codex helper/ }));
    expect(mocks.setClaudeSetup).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledWith(claudeSetup(true)));
    expect(await screen.findByText("Claude Code setup saved.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /^Claude with Codex helper/ })).toHaveAttribute("aria-pressed", "true");
    await goTo("Accounts");
    // Only ChatGPT accounts can be failover targets; API-key cards get no switch.
    const allow = await screen.findByRole("switch", { name: "Claude may use person@example.com" });
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(allow).not.toBeChecked();

    await userEvent.click(allow);
    await waitFor(() => expect(mocks.setAccountInvokeAllowed).toHaveBeenCalledWith("account-1", true));
    expect(allow).toBeChecked();
    expect(mocks.switchAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["claude-only", "Claude alone", "mixed", "on", false],
    ["claude-codex", "Claude with Codex helper", "mixed", "on", true],
    ["router", "Automatic team", "mixed", "on", true],
    ["router", "Automatic team", "mixed", "off", true],
    ["router", "Automatic team", "codex", "on", true],
    ["router", "Automatic team", "codex", "off", true],
    ["router", "Automatic team", "claude", "on", true],
    ["router", "Automatic team", "claude", "off", false],
  ] as const)("saves %s / %s / %s / %s with its exact payload", async (kind, name, mode, review, enabled) => {
    const initial = claudeSetup(true);
    initial.router.claudeOnlyReview = review;
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: initial, allowed_invocation_profiles: [] });
    render(<App />);
    const panel = await openClaudeSetup();
    expect(within(panel).getByRole("button", { name: /^Claude with Codex helper/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(panel).getByRole("button", { name: new RegExp("^" + name.replace("+", "\\+")) }));
    if (kind === "router") {
      await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Who writes the code" }), mode);
      const reviewControl = within(panel).queryByRole("combobox", { name: "Codex reviews Claude's changes" });
      if (mode === "claude") {
        expect(reviewControl).toBeInTheDocument();
        await userEvent.selectOptions(reviewControl!, review);
      } else {
        expect(reviewControl).not.toBeInTheDocument();
      }
      expect(within(panel).getAllByRole("checkbox")).toHaveLength(16);
      expect(within(panel).getByRole("checkbox", { name: "Try cheaper models on easy tasks" })).toBeChecked();
      await userEvent.click(within(panel).getByRole("checkbox", { name: "haiku high" }));
    }
    const expected: ClaudeSetup = {
      ...initial,
      setup: kind,
      router: {
        ...initial.router,
        mode,
        claudeOnlyReview: review,
        claudeAllowed: { ...initial.router.claudeAllowed,
          haiku: kind === "router" ? ["low", "medium", "high"] : ["low", "medium"] },
      },
    };
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith(expected));
    expect(await screen.findByText("Claude Code setup saved.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: new RegExp("^" + name.replace("+", "\\+")) })).toHaveAttribute("aria-pressed", "true");
    await goTo("Accounts");
    // The hidden Claude Code page also lists the account.
    await screen.findByRole("heading", { name: "person@example.com" });
    expect(screen.queryAllByRole("switch")).toHaveLength(enabled ? 1 : 0);
  });

  it.each(["codex", "claude", "price"] as const)("saves Use first %s only in mixed mode", async (prefer) => {
    render(<App />);
    const panel = await openClaudeSetup();
    expect(within(panel).queryByRole("combobox", { name: "Try first" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    const control = within(panel).getByRole("combobox", { name: "Try first" });
    expect(control).toHaveValue("codex");
    expect(within(control).getAllByRole("option").map((option) => option.textContent)).toEqual(["Codex", "Claude", "Cheapest"]);
    await userEvent.selectOptions(control, prefer);
    const mode = within(panel).getByRole("combobox", { name: "Who writes the code" });
    for (const value of ["claude", "codex"]) {
      await userEvent.selectOptions(mode, value);
      expect(within(panel).queryByRole("combobox", { name: "Try first" })).not.toBeInTheDocument();
    }
    await userEvent.selectOptions(mode, "mixed");
    expect(within(panel).getByRole("combobox", { name: "Try first" })).toHaveValue(prefer);
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    const initial = claudeSetup(false);
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith({ ...initial, setup: "router", router: { ...initial.router, prefer } }));
  });


  it.each(["normal", "fast", "orchestrator"] as const)("saves Codex speed %s and retains the cutoff across setup modes", async (speed) => {
    render(<App />);
    const panel = await openClaudeSetup();
    expect(within(panel).queryByRole("combobox", { name: "Codex speed" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: /^Claude with Codex helper/ }));
    const control = within(panel).getByRole("combobox", { name: "Codex speed" });
    expect(control).toHaveValue("normal");
    expect(within(control).getAllByRole("option").map((option) => option.textContent)).toEqual(["Normal", "Fast", "Claude decides"]);
    expect(within(panel).queryByRole("spinbutton", { name: "Use Normal below (% usage left)" })).not.toBeInTheDocument();
    await userEvent.selectOptions(control, speed);
    if (speed !== "normal") {
      const cutoff = within(panel).getByRole("spinbutton", { name: "Use Normal below (% usage left)" });
      expect(cutoff).toHaveValue(20);
      await userEvent.clear(cutoff);
      await userEvent.type(cutoff, "35");
    }
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    const mode = within(panel).getByRole("combobox", { name: "Who writes the code" });
    await userEvent.selectOptions(mode, "claude");
    expect(within(panel).queryByRole("combobox", { name: "Codex speed" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("spinbutton", { name: "Use Normal below (% usage left)" })).not.toBeInTheDocument();
    for (const value of ["codex", "mixed"]) {
      await userEvent.selectOptions(mode, value);
      expect(within(panel).getByRole("combobox", { name: "Codex speed" })).toHaveValue(speed);
      if (speed !== "normal") expect(within(panel).getByRole("spinbutton", { name: "Use Normal below (% usage left)" })).toHaveValue(35);
    }
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    const initial = claudeSetup(false);
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith({
      ...initial, setup: "router", codexSpeed: { mode: speed, fastMinRemaining: speed === "normal" ? 20 : 35 },
    }));
  });

  it("saves Normal after clearing the Fast cutoff", async () => {
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Claude with Codex helper/ }));
    const speed = within(panel).getByRole("combobox", { name: "Codex speed" });
    await userEvent.selectOptions(speed, "fast");
    await userEvent.clear(within(panel).getByRole("spinbutton", { name: "Use Normal below (% usage left)" }));
    await userEvent.selectOptions(speed, "normal");
    expect(within(panel).queryByRole("spinbutton", { name: "Use Normal below (% usage left)" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith(claudeSetup(true)));
  });

  it("keeps the saved cutoff when clearing it and switching to Claude only", async () => {
    const initial = { ...claudeSetup(true), codexSpeed: { mode: "fast" as const, fastMinRemaining: 35 } };
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: initial, allowed_invocation_profiles: [] });
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.clear(within(panel).getByRole("spinbutton", { name: "Use Normal below (% usage left)" }));
    await userEvent.click(within(panel).getByRole("button", { name: /^Claude alone/ }));
    expect(within(panel).queryByRole("combobox", { name: "Codex speed" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith({ ...initial, setup: "claude-only" }));
  });

  it.each(["", "-1", "91", "20.5"])("refuses an invalid Fast cutoff %s", async (value) => {
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Claude with Codex helper/ }));
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Codex speed" }), "fast");
    const cutoff = within(panel).getByRole("spinbutton", { name: "Use Normal below (% usage left)" });
    fireEvent.change(cutoff, { target: { value } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(mocks.setClaudeSetup).not.toHaveBeenCalled();
    expect(within(panel).getByRole("alert")).toHaveTextContent("integer between 0 and 90");
  });

  it.each(["0", "90"])("saves the Fast cutoff boundary %s", async (value) => {
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Claude with Codex helper/ }));
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Codex speed" }), "fast");
    fireEvent.change(within(panel).getByRole("spinbutton", { name: "Use Normal below (% usage left)" }), { target: { value } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith({
      ...claudeSetup(true), codexSpeed: { mode: "fast", fastMinRemaining: Number(value) },
    }));
  });

  it.each(["mixed", "claude", "codex"] as const)("saves sampling in %s mode", async (mode) => {
    render(<App />);
    const panel = await openClaudeSetup();
    expect(within(panel).queryByRole("checkbox", { name: "Try cheaper models on easy tasks" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Who writes the code" }), mode);
    const control = within(panel).getByRole("checkbox", { name: "Try cheaper models on easy tasks" });
    expect(control).toBeChecked();
    await userEvent.click(control);
    expect(control).not.toBeChecked();
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    const initial = claudeSetup(false);
    await waitFor(() => expect(mocks.setClaudeSetup).toHaveBeenCalledExactlyOnceWith({ ...initial, setup: "router", router: { ...initial.router, mode, sampling: "off" } }));
  });

  it("cancels draft changes without saving", async () => {
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    await userEvent.click(within(panel).getByRole("checkbox", { name: "haiku high" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(mocks.setClaudeSetup).not.toHaveBeenCalled();
    expect(within(panel).getByRole("button", { name: /^Claude alone/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    expect(within(panel).getByRole("checkbox", { name: "haiku high" })).not.toBeChecked();
  });

  it("keeps a router draft while the Codex helper settings are saved", async () => {
    mocks.modelCatalog.mockResolvedValue([
      { model: "model-a", display_name: "Model A", supported_reasoning_efforts: ["low"], is_default: true },
    ]);
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    await userEvent.click(within(panel).getByRole("checkbox", { name: "haiku high" }));
    const helper = screen.getByRole("region", { name: "Codex helper" });
    await waitFor(() => expect(within(helper).getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(within(helper).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Codex helper settings saved.")).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: "haiku high" })).toBeChecked();
    expect(mocks.setClaudeSetup).not.toHaveBeenCalled();
  });

  it("keeps the panel open and setup unchanged when publication fails", async () => {
    mocks.setClaudeSetup.mockRejectedValue("Unable to atomically replace Claude Code setup");
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Claude Code setup was not saved.");
    expect(within(panel).getByRole("button", { name: "Save" })).toBeEnabled();
    await goTo("Home");
    expect(await screen.findByRole("region", { name: "How your setup works" }))
      .toHaveTextContent("Claude alone: Claude Code does all the work. Codex is not used.");
  });

  it("still shows a setup save that fails after leaving the page", async () => {
    let reject: (reason: unknown) => void = () => {};
    mocks.setClaudeSetup.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    render(<App />);
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: /^Automatic team/ }));
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await goTo("Home");
    await act(async () => reject("Unable to atomically replace Claude Code setup"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Claude Code setup was not saved.");
    await goTo("Claude Code");
    expect(within(await screen.findByRole("region", { name: "Claude Code" })).getByRole("alert"))
      .toHaveTextContent("Claude Code setup was not saved.");
  });

  it("opens the panel while paused and clears the pause after a saved human decision", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.invokePause.mockResolvedValue({ resumes_at: null });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Codex helper paused" })).toBeInTheDocument();
    const panel = await openClaudeSetup();
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Codex helper paused" })).not.toBeInTheDocument());
    expect(mocks.setClaudeSetup).toHaveBeenCalledWith(claudeSetup(true));
  });

  it("keeps the account unchanged and explains when eligibility cannot be saved", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.setAccountInvokeAllowed.mockRejectedValue("Account store lock is unavailable");
    render(<App />);
    await goTo("Accounts");

    const allow = await screen.findByRole("switch", { name: "Claude may use person@example.com" });
    await userEvent.click(allow);
    expect(await screen.findByText("Could not change whether Claude may use this account.")).toBeInTheDocument();
    expect(allow).not.toBeChecked();
  });

  it("whitelists only the efforts each Codex model supports", async () => {
    mocks.invokeSettings.mockResolvedValue({
      invoke_mode: true, claude_setup: claudeSetup(true),
      allowed_invocation_profiles: [{ model: "model-b", reasoning_efforts: ["medium"] }],
    });
    mocks.modelCatalog.mockResolvedValue([
      { model: "model-a", display_name: "Model A", supported_reasoning_efforts: ["low", "high", "max"], is_default: true },
      { model: "model-b", display_name: "Model B", supported_reasoning_efforts: ["low", "medium"], is_default: false },
    ]);
    render(<App />);

    const dialog = await openInvokeSettings();
    expect(await within(dialog).findByRole("checkbox", { name: "medium reasoning for Model B" })).toBeChecked();
    expect(within(dialog).queryByRole("checkbox", { name: "medium reasoning for Model A" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "max reasoning for Model A" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "low reasoning for Model A" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "medium reasoning for Model B" }));
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Default model for Review" }), "model-a");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.setInvokeProfiles).toHaveBeenCalledWith([
      { model: "model-a", reasoning_efforts: ["low", "max"] },
    ]));
    expect(mocks.setInvokeTaskDefaults).toHaveBeenCalledWith({ review: { model: "model-a", effort: "low" } });
    expect(await screen.findByText("Codex helper settings saved.")).toBeInTheDocument();
  });

  it("saves the account order and limits with the allowed models", async () => {
    const second: AccountView = { ...chatAccount, id: "account-2", email: "second@example.com", label: "Second", plan_type: "pro", invoke_allowed: true };
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, invoke_allowed: false }, second]);
    mocks.invokeSettings.mockResolvedValue({
      invoke_mode: true, claude_setup: claudeSetup(true),
      allowed_invocation_profiles: [],
      account_priority: ["account-1", "account-2"],
      preferred_min_remaining: 20,
      max_concurrent_tasks: 2,
    });
    mocks.modelCatalog.mockResolvedValue([
      { model: "model-a", display_name: "Model A", supported_reasoning_efforts: ["low"], is_default: true },
    ]);
    render(<App />);

    await goTo("Accounts");
    const card = await screen.findByRole("region", { name: "Order Claude uses" });
    expect(within(card).getByText("Not allowed")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Move person@example.com up" })).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Move second@example.com up" }));
    // The draft survives leaving the page.
    await goTo("Home");
    await goTo("Accounts");
    const again = await screen.findByRole("region", { name: "Order Claude uses" });
    expect(within(again).getByRole("button", { name: "Move second@example.com up" })).toBeDisabled();
    // The real backend returns the whole saved settings.
    mocks.setInvokeWeeklyReserve.mockImplementation(async (reserve: Record<string, number>) => ({
      invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [],
      account_priority: ["account-2", "account-1"], preferred_min_remaining: 20, max_concurrent_tasks: 2, weekly_reserve: reserve,
    }));
    await userEvent.click(within(again).getByRole("button", { name: "Save" }));
    // Values this card does not own are the saved ones.
    await waitFor(() => expect(mocks.setInvokePreferences).toHaveBeenCalledWith(["account-2", "account-1"], 20, 2, false));
    expect(mocks.setInvokeWeeklyReserve).toHaveBeenCalledWith({});
    expect(await screen.findByText("Codex helper settings saved.")).toBeInTheDocument();
    mocks.setInvokePreferences.mockClear();
    mocks.setInvokeWeeklyReserve.mockClear();

    const dialog = await openInvokeSettings();
    const threshold = within(dialog).getByRole("spinbutton", { name: /Move on below/ });
    await userEvent.clear(threshold);
    await userEvent.type(threshold, "35");
    const tasks = within(dialog).getByRole("spinbutton", { name: /Codex tasks at the same time/ });
    await userEvent.clear(tasks);
    await userEvent.type(tasks, "9");
    const autoWake = within(dialog).getByRole("checkbox", { name: /Start reset timers automatically/ });
    expect(autoWake).not.toBeChecked();
    await userEvent.click(autoWake);
    await userEvent.click(await within(dialog).findByRole("button", { name: "Save" }));

    // Out-of-range values are kept within limits; the saved order is kept and
    // the reserve is not touched.
    await waitFor(() => expect(mocks.setInvokePreferences).toHaveBeenCalledWith(["account-2", "account-1"], 35, 6, true));
    expect(mocks.setInvokeWeeklyReserve).not.toHaveBeenCalled();
    expect(await screen.findByText("Codex helper settings saved.")).toBeInTheDocument();
  });

  it("sends the saved limits when the order card is saved", async () => {
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, invoke_allowed: true }]);
    mocks.invokeSettings.mockResolvedValue({
      invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [],
      account_priority: ["account-1"], preferred_min_remaining: 35, max_concurrent_tasks: 4, auto_wake: true,
    });
    render(<App />);
    await goTo("Accounts");
    const card = await screen.findByRole("region", { name: "Order Claude uses" });
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setInvokePreferences).toHaveBeenCalledWith(["account-1"], 35, 4, true));
  });

  it("opens Accounts from the Codex helper pointer", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    render(<App />);
    const panel = await openInvokeSettings();
    await userEvent.click(within(panel).getByRole("button", { name: "Open Accounts" }));
    expect(await screen.findByRole("region", { name: "Order Claude uses" })).toBeInTheDocument();
  });

  it("marks a model that only some accounts offer", async () => {
    const pro: AccountView = { ...chatAccount, id: "account-2", email: "pro@example.com", label: "Pro", plan_type: "pro" };
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, plan_type: "plus" }, pro]);
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.modelCatalog.mockResolvedValue([
      { model: "model-a", display_name: "Model A", supported_reasoning_efforts: ["low"], is_default: true },
      { model: "model-pro", display_name: "Model Pro", supported_reasoning_efforts: ["high"], is_default: false, only_on: ["account-2"] },
      { model: "model-gone", display_name: "Model Gone", supported_reasoning_efforts: ["high"], is_default: false, only_on: [] },
    ]);
    render(<App />);

    const dialog = await openInvokeSettings();
    const badge = await within(dialog).findByText("Only on Pro");
    expect(badge).toHaveAttribute("title", expect.stringContaining("pro@example.com"));
    expect(within(dialog).getByText("Not on your accounts")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Only on /)).toHaveLength(1);
  });

  it("lists delegated Codex tasks and stops one after a confirming click", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.invokeTasks.mockResolvedValue([
      { id: "task-1", started_at: Date.now() - 125_000, model: "gpt-6.1-sol", reasoning_effort: "medium", write: true, cwd: "C:\\work\\studio-app", thread_id: "01a1f2c3-4455-6677", running: true },
      { id: "task-2", started_at: Date.now() - 5_000, model: "gpt-6-luna", reasoning_effort: "low", write: false, cwd: "/work/other", thread_id: null, running: false },
    ]);
    render(<App />);

    const strip = await screen.findByRole("region", { name: "Running now" });
    expect(await within(strip).findByText("Running")).toBeInTheDocument();
    expect(within(strip).getByRole("list", { name: "Codex tasks" })).toBeInTheDocument();
    expect(within(strip).getByText("Waiting")).toBeInTheDocument();
    expect(within(strip).getByText("studio-app")).toHaveAttribute("title", "C:\\work\\studio-app");
    expect(within(strip).getByText("Thread 01a1f2c3")).toHaveAttribute("title", "01a1f2c3-4455-6677");
    expect(within(strip).getByText("Edits files")).toBeInTheDocument();

    const stop = within(strip).getByRole("button", { name: "Stop the gpt-6.1-sol task in studio-app" });
    await userEvent.click(stop);
    expect(mocks.stopInvokeTask).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await userEvent.click(within(strip).getByRole("button", { name: "Stop task?" }));
    await waitFor(() => expect(mocks.stopInvokeTask).toHaveBeenCalledWith("task-1"));
    // The confirmed stop shows at once and the task stays listed while it ends.
    expect(within(strip).getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(within(strip).getAllByText("Stopping…").length).toBe(2);
  });

  it("follows a running task's Codex log like a terminal", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.invokeTasks.mockResolvedValue([
      { id: "task-1", started_at: Date.now() - 30_000, model: "gpt-6.1-sol", reasoning_effort: "medium", write: true, cwd: "/work/studio-app", thread_id: "01a1f2c3-4455", running: true },
    ]);
    mocks.readTaskLog
      .mockResolvedValueOnce({
        found: true,
        offset: 100,
        items: [
          { kind: "task", text: "Add removeItem" },
          { kind: "command", text: "git status --short" },
          { kind: "output", text: " M cart.js" },
          { kind: "tokens", total: 1234 },
        ],
      })
      .mockResolvedValueOnce({
        found: true,
        offset: 180,
        items: [{ kind: "patch", files: ["cart.js"] }, { kind: "done", seconds: 12.3 }],
      });
    render(<App />);

    const strip = await screen.findByRole("region", { name: "Running now" });
    await userEvent.click(await within(strip).findByRole("button", { name: "Watch the gpt-6.1-sol task in studio-app" }));
    const dialog = await screen.findByRole("dialog", { name: "gpt-6.1-sol in studio-app" });
    const log = within(dialog).getByRole("log");
    expect(await within(log).findByText("$ git status --short")).toBeInTheDocument();
    expect(within(log).getByText("Add removeItem")).toBeInTheDocument();
    expect(within(dialog).getByText("1,234 tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("Live")).toBeInTheDocument();
    expect(await within(log).findByText("Edited cart.js", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(log).getByText("Finished in 12.3 s")).toBeInTheDocument();
    expect(mocks.readTaskLog).toHaveBeenNthCalledWith(1, "01a1f2c3-4455", 0);
    expect(mocks.readTaskLog).toHaveBeenNthCalledWith(2, "01a1f2c3-4455", 100);
  });

  it("opens a finished task's log from the activity history", async () => {
    mocks.activity.mockResolvedValue([
      { at: Date.now() - 60_000, kind: "task_ended", task: "t", model: "gpt-6-luna", thread_id: "01a1e9b8-0000", status: "completed" },
    ]);
    mocks.readTaskLog.mockResolvedValue({ found: true, offset: 10, items: [{ kind: "message", text: "All tests pass." }] });
    render(<App />);

    await goTo("Results");
    const history = await screen.findByRole("region", { name: "Activity" });
    await userEvent.click(await within(history).findByRole("button", { name: "View log" }));
    const dialog = await screen.findByRole("dialog", { name: "Codex thread 01a1e9b8" });
    expect((await within(dialog).findAllByText("All tests pass."))[0]).toBeInTheDocument();
    expect(within(dialog).getByText("Ended")).toBeInTheDocument();
    expect(mocks.readTaskLog).toHaveBeenCalledWith("01a1e9b8-0000", 0);
  });

  it.each([
    [{ input_tokens: 110400, cached_input_tokens: 98100, output_tokens: 4200, reasoning_output_tokens: 400 }, "Input 12.3k · Cached 98.1k (89% hit) · Output 4.2k"],
    [{ cached_input_tokens: 25000, output_tokens: 4200 }, "Cached 25k · Output 4.2k"],
    [{ input_tokens: 30000, output_tokens: 4200 }, "Output 4.2k"],
    [{ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, "Input 0 · Cached 0 · Output 0"],
    [{ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }, "Input 1k · Cached 0 (0% hit) · Output 100"],
    [{}, "1,234 tokens"],
  ])("shows known Watch token fields without inventing missing counts (%j)", async (usage, expected) => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.invokeTasks.mockResolvedValue([
      { id: "task-1", started_at: Date.now(), model: "m", reasoning_effort: "low", write: false, cwd: "/work", thread_id: "thread-1", running: true },
    ]);
    mocks.readTaskLog.mockResolvedValue({ found: true, offset: 1, items: [{ kind: "tokens", total: 1234, ...usage }] });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Watch the m task in work" }));
    const dialog = await screen.findByRole("dialog", { name: "m in work" });
    expect(await within(dialog).findByText(expected)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/NaN|undefined|Infinity/);
  });

  it("opens two live logs, focuses an existing one, and closes each independently", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.invokeTasks.mockResolvedValue([1, 2].map((id) => ({
      id: `task-${id}`, started_at: Date.now(), model: `m${id}`, reasoning_effort: "low", write: false,
      cwd: `/work/project${id}`, thread_id: `thread-${id}`, running: true,
    })));
    mocks.readTaskLog.mockImplementation(async (threadId: string, offset: number) => ({
      found: true, offset: 10, items: offset ? [] : [
        { kind: "message", text: `Log for ${threadId}` },
        { kind: "tokens", total: 1200, input_tokens: 1000, cached_input_tokens: threadId === "thread-1" ? 900 : 500, output_tokens: 200 },
      ],
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Watch the m1 task in project1" }));
    const first = await screen.findByRole("dialog", { name: "m1 in project1" });
    expect(await within(first).findByText("Log for thread-1")).toBeInTheDocument();
    await userEvent.selectOptions(within(first).getByRole("combobox", { name: "Watch another task" }), "task-2");
    const dialog = await screen.findByRole("dialog", { name: "Codex task logs" });
    expect(within(dialog).getAllByRole("log")).toHaveLength(2);
    expect(await within(dialog).findByText("Log for thread-2")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Live")).toHaveLength(2);
    expect(within(dialog).getByText("Input 100 · Cached 900 (90% hit) · Output 200")).toBeInTheDocument();
    expect(within(dialog).getByText("Input 500 · Cached 500 (50% hit) · Output 200")).toBeInTheDocument();
    const secondLog = within(dialog).getByRole("region", { name: "m2 in project2" });
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Watch another task" }), "task-1");
    expect(within(dialog).getAllByRole("log")).toHaveLength(2);
    expect(within(dialog).getByRole("region", { name: "m1 in project1" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close m1 in project1" }));
    expect(await screen.findByRole("dialog", { name: "m2 in project2" })).toBeInTheDocument();
    expect(screen.queryByText("Log for thread-1")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "m2 in project2" })).toBe(secondLog);
    expect(mocks.readTaskLog.mock.calls.filter(([thread, offset]) => thread === "thread-2" && offset === 0)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Close m2 in project2" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("replaces the oldest open log on the fifth task without reordering a focused log", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.invokeTasks.mockResolvedValue([1, 2, 3, 4, 5].map((id) => ({
      id: `task-${id}`, started_at: Date.now(), model: `m${id}`, reasoning_effort: "low", write: false,
      cwd: "/work", thread_id: `thread-${id}`, running: true,
    })));
    mocks.readTaskLog.mockResolvedValue({ found: true, offset: 1, items: [] });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Watch the m1 task in work" }));
    for (const id of [2, 3, 4, 1, 5]) {
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Watch another task" }), `task-${id}`);
    }
    const dialog = screen.getByRole("dialog", { name: "Codex task logs" });
    expect(within(dialog).getAllByRole("log")).toHaveLength(4);
    expect(within(dialog).queryByRole("region", { name: "m1 in work" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "m5 in work" })).toBeInTheDocument();
  });

  it("adds another Activity log from the log panel", async () => {
    mocks.activity.mockResolvedValue([1, 2].map((id) => ({
      at: Date.now(), kind: "task_ended", task: `t${id}`, model: "m", thread_id: `thread-${id}`, status: "completed",
    })));
    mocks.readTaskLog.mockResolvedValue({ found: true, offset: 1, items: [] });
    render(<App />);
    await goTo("Results");
    const history = await screen.findByRole("region", { name: "Activity" });
    await userEvent.click((await within(history).findAllByRole("button", { name: "View log" }))[0]);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Watch another task" }), "thread-2");
    const dialog = screen.getByRole("dialog", { name: "Codex task logs" });
    expect(within(dialog).getAllByRole("log")).toHaveLength(2);
    expect(within(dialog).getAllByText("Ended")).toHaveLength(2);
  });

  it("shows no task strip in Manual Mode", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: false, claude_setup: claudeSetup(false), allowed_invocation_profiles: [] });
    mocks.invokeTasks.mockResolvedValue([
      { id: "task-1", started_at: Date.now(), model: "m", reasoning_effort: "low", write: false, cwd: "/x", running: true },
    ]);
    render(<App />);
    const running = await screen.findByRole("region", { name: "Running now" });
    expect(within(running).getByText("Nothing is running.")).toBeInTheDocument();
    expect(mocks.invokeTasks).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Codex tasks" })).not.toBeInTheDocument();
  });

  it("shows the activity history with account names and live entries", async () => {
    const second: AccountView = { ...chatAccount, id: "account-2", email: "second@example.com", label: "Second" };
    mocks.listAccounts.mockResolvedValue([chatAccount, second]);
    mocks.activity.mockResolvedValue([
      { at: Date.now() - 180_000, kind: "task_started", task: "t", model: "gpt-6-luna", effort: "low", write: false, cwd: "/work" },
      { at: Date.now() - 60_000, kind: "switched", from: "account-1", to: "account-2", reason: "usage_limit" },
      { at: Date.now() - 120_000, kind: "task_ended", task: "t", model: "gpt-6-luna", thread_id: "01a1e9b8-0000", status: "failed", code: "CODEX_FAILED", usage: { input_tokens: 30000, cached_input_tokens: 25000, output_tokens: 11200, reasoning_output_tokens: 400, total_tokens: 41200 } },
    ]);
    let push: ((entry: unknown) => void) | undefined;
    mocks.onInvokeActivity.mockImplementation(async (handler: typeof push) => {
      push = handler;
      return () => undefined;
    });
    render(<App />);

    await goTo("Results");
    const dialog = await screen.findByRole("region", { name: "Activity" });
    expect(await within(dialog).findByText(
      "Switched Codex from person@example.com to second@example.com: person@example.com ran out of usage.",
    )).toBeInTheDocument();
    expect(within(dialog).getByText("Codex task on gpt-6-luna did not finish (CODEX_FAILED), thread 01a1e9b8.")).toBeInTheDocument();
    expect(within(dialog).getByText("41.2k tokens · Input 5k · Cached 25k (83% hit) · Output 11.2k")).toBeInTheDocument();
    expect(within(dialog).getByText("Input 5k · Cached 25k (83% hit) · Output 11.2k")).toBeInTheDocument();
    expect(within(dialog).getByText("Last 7 days by model and effort")).toBeInTheDocument();
    expect(within(dialog).getByText("Tasks 1 · 41.2k tokens")).toBeInTheDocument();

    await waitFor(() => expect(push).toBeDefined());
    act(() => push!({ at: Date.now(), kind: "woke", accounts: ["account-2"] }));
    const history = dialog.querySelector(".activity-list") as HTMLElement;
    const items = within(history).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Started the reset timer for second@example.com.");
  });

  it("aggregates Activity hit rate from full input totals and tolerates older usage", async () => {
    mocks.activity.mockResolvedValue([
      { at: Date.now(), kind: "task_ended", task: "a", model: "m", status: "completed", usage: { input_tokens: 10000, cached_input_tokens: 9000, output_tokens: 200, total_tokens: 10200 } },
      { at: Date.now(), kind: "task_ended", task: "b", model: "m", status: "completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100 } },
      { at: Date.now(), kind: "task_ended", task: "old", model: "legacy", status: "completed", usage: { total_tokens: 1234 } },
      { at: Date.now(), kind: "task_ended", task: "partial", model: "partial", status: "completed", usage: { input_tokens: 10000, output_tokens: 200, total_tokens: 10200 } },
    ]);
    render(<App />);
    await goTo("Results");
    const dialog = await screen.findByRole("region", { name: "Activity" });
    expect(await within(dialog).findByText("Input 2k · Cached 9k (82% hit) · Output 300")).toBeInTheDocument();
    expect(within(dialog).getByText("1.2k tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("10.2k tokens · Output 200")).toBeInTheDocument();
    expect(within(dialog).getByText("Output 200")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/NaN|undefined|Infinity/);
  });

  it("saves a weekly reserve for an account", async () => {
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, invoke_allowed: true }]);
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [], weekly_reserve: {} });
    mocks.modelCatalog.mockResolvedValue([
      { model: "model-a", display_name: "Model A", supported_reasoning_efforts: ["low"], is_default: true },
    ]);
    render(<App />);

    await goTo("Accounts");
    const dialog = await screen.findByRole("region", { name: "Order Claude uses" });
    const reserve = within(dialog).getByRole("spinbutton", { name: "Keep for yourself for person@example.com" });
    await userEvent.type(reserve, "30");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.setInvokeWeeklyReserve).toHaveBeenCalledWith({ "account-1": 30 }));
    expect(await screen.findByText("Codex helper settings saved.")).toBeInTheDocument();
  });

  it("says which paused threads can continue when usage is back", async () => {
    let announce: ((resumed: { threads: { thread_id: string }[]; by_user: boolean }) => void) | undefined;
    mocks.onInvokeResumed.mockImplementation(async (handler: typeof announce) => {
      announce = handler;
      return () => undefined;
    });
    render(<App />);
    await waitFor(() => expect(announce).toBeDefined());
    act(() => announce!({ threads: [{ thread_id: "01a1-aaaa" }, { thread_id: "01a1-bbbb" }], by_user: false }));
    expect(await screen.findByText(
      "Codex usage is back. Tell Claude to continue the paused threads: 01a1-aaaa, 01a1-bbbb.",
    )).toBeInTheDocument();
  });

  it("says which accounts automatic Wake started", async () => {
    const second: AccountView = { ...chatAccount, id: "account-2", email: "second@example.com", label: "Second" };
    mocks.listAccounts.mockResolvedValue([chatAccount, second]);
    let announce: ((accounts: string[]) => void) | undefined;
    mocks.onInvokeAutoWoke.mockImplementation(async (handler: typeof announce) => {
      announce = handler;
      return () => undefined;
    });
    render(<App />);
    await goTo("Accounts");
    await screen.findAllByText("person@example.com");
    await waitFor(() => expect(announce).toBeDefined());

    act(() => announce!(["account-2"]));
    expect(await screen.findByText("Started the reset timer for second@example.com.")).toBeInTheDocument();
  });

  it("says when Invoke Mode moved Codex to a preferred account", async () => {
    const second: AccountView = { ...chatAccount, id: "account-2", email: "second@example.com", label: "Second" };
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, active: true }, second]);
    let announce: ((switched: { from: string; to: string; reason?: string }) => void) | undefined;
    mocks.onInvokeAccountSwitched.mockImplementation(async (handler: typeof announce) => {
      announce = handler;
      return () => undefined;
    });
    render(<App />);
    await goTo("Accounts");
    await screen.findAllByText("person@example.com");
    await waitFor(() => expect(announce).toBeDefined());

    act(() => announce!({ from: "account-1", to: "account-2", reason: "priority" }));
    expect(await screen.findByText(
      "The Codex helper switched Codex from person@example.com to second@example.com, your preferred account with usage left.",
    )).toBeInTheDocument();
    act(() => announce!({ from: "account-2", to: "account-1", reason: "model" }));
    expect(await screen.findByText(
      "The Codex helper switched Codex from second@example.com to person@example.com, which offers the model Claude asked for.",
    )).toBeInTheDocument();
  });

  it("reloads accounts and names both accounts after an automatic switch", async () => {
    const second: AccountView = { ...chatAccount, id: "account-2", email: "second@example.com", label: "Second" };
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, active: true }, second]);
    let notify: ((switched: { from: string; to: string }) => void) | undefined;
    mocks.onInvokeAccountSwitched.mockImplementation(async (handler: typeof notify) => {
      notify = handler;
      return () => undefined;
    });
    render(<App />);
    await goTo("Accounts");
    expect((await screen.findAllByText("second@example.com")).length).toBeGreaterThan(0);
    await waitFor(() => expect(notify).toBeDefined());
    const snapshots = mocks.appSnapshot.mock.calls.length;

    act(() => notify!({ from: "account-1", to: "account-2" }));
    expect(await screen.findByText(
      "person@example.com reached its Codex usage limit. The Codex helper switched Codex to second@example.com.",
    )).toBeInTheDocument();
    await waitFor(() => expect(mocks.appSnapshot.mock.calls.length).toBeGreaterThan(snapshots));
  });

  it("asks the user to close Codex while a switch waits, and lets them cancel it", async () => {
    const second: AccountView = { ...chatAccount, id: "account-2", email: "second@example.com", label: "Second" };
    mocks.listAccounts.mockResolvedValue([{ ...chatAccount, active: true }, second]);
    mocks.invokeFailover.mockResolvedValue({ from: "account-1", to: "account-2" });
    let update: ((waiting: { from: string; to: string } | null) => void) | undefined;
    mocks.onInvokeFailoverWaiting.mockImplementation(async (handler: typeof update) => {
      update = handler;
      return () => undefined;
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Close Codex to continue" })).toBeInTheDocument();
    expect(await screen.findByText(/person@example\.com reached its Codex usage limit\. Quit Codex .* switch to second@example\.com\./))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel switch" }));
    await waitFor(() => expect(mocks.cancelInvokeFailover).toHaveBeenCalledOnce());
    expect(mocks.switchAccount).not.toHaveBeenCalled();

    act(() => update!(null));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Close Codex to continue" })).not.toBeInTheDocument());
  });

  it("shows the close-Codex request when it arrives while the window is open", async () => {
    let update: ((waiting: { from: string; to: string } | null) => void) | undefined;
    mocks.onInvokeFailoverWaiting.mockImplementation(async (handler: typeof update) => {
      update = handler;
      return () => undefined;
    });
    render(<App />);
    await goTo("Accounts");
    await screen.findAllByText("person@example.com");
    expect(screen.queryByRole("heading", { name: "Close Codex to continue" })).not.toBeInTheDocument();

    await waitFor(() => expect(update).toBeDefined());
    act(() => update!({ from: "account-1", to: "missing" }));
    expect(await screen.findByRole("heading", { name: "Close Codex to continue" })).toBeInTheDocument();
  });

  it("says Invoke Mode is paused until the reset and lets the user resume it", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    mocks.invokePause.mockResolvedValue({ resumes_at: resetsAt });
    let update: ((pause: { resumes_at: number | null } | null) => void) | undefined;
    mocks.onInvokePaused.mockImplementation(async (handler: typeof update) => {
      update = handler;
      return () => undefined;
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Codex helper paused" })).toBeInTheDocument();
    expect(screen.getByText(/out of Codex usage, so Claude was told to pause its work\. The Codex helper resumes at .+\./))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(mocks.resumeInvoke).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Codex helper paused" })).not.toBeInTheDocument());

    // A later pause with no known reset time arrives as an event.
    act(() => update!({ resumes_at: null }));
    expect(await screen.findByText(/Allow another account, or choose Resume now once usage is available again\./))
      .toBeInTheDocument();
    act(() => update!(null));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Codex helper paused" })).not.toBeInTheDocument());
  });

  it("keeps the dialog open with a safe message when the model list cannot be read", async () => {
    mocks.invokeSettings.mockResolvedValue({ invoke_mode: true, claude_setup: claudeSetup(true), allowed_invocation_profiles: [] });
    mocks.modelCatalog.mockRejectedValue("Unable to start Codex App Server. Check that Codex is installed.");
    render(<App />);

    const dialog = await openInvokeSettings();
    expect(await within(dialog).findByText("Could not read the Codex model list.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.setInvokeProfiles).not.toHaveBeenCalled();
  });
});
