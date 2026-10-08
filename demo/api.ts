import type { AccountView, AppSnapshot, ClaudeSetup, InvokeSettings, QuotaView } from "../src/types";

// This file is loaded only by `vite --mode demo`. It contains display data,
// never imports Tauri, and rejects every account mutation. Setup changes are local mocks.
if ("__TAURI_INTERNALS__" in window) {
  throw new Error("The README demo cannot run inside Tauri.");
}

const fixedNow = new Date(2026, 8, 26, 10, 0).getTime();
Date.now = () => fixedNow;
const at = (day: number, hour: number, minute = 0) => Math.floor(new Date(2026, 8, day, hour, minute).getTime() / 1000);

const accounts: AccountView[] = [
  { id: "demo-1", label: "Studio", kind: "chat_gpt", email: "alex@example.com", workspace_name: "Studio", plan_type: "team", active: true, invoke_allowed: true },
  { id: "demo-2", label: "Studio", kind: "chat_gpt", email: "riley@example.org", workspace_name: "Studio", plan_type: "team", active: false },
  { id: "demo-3", label: "Research", kind: "chat_gpt", email: "sam@example.net", workspace_name: "Research", plan_type: "team", active: false, invoke_allowed: true },
  { id: "demo-4", label: "Personal", kind: "chat_gpt", email: "taylor@example.com", workspace_name: "Personal", plan_type: "plus", active: false, invoke_allowed: true },
  { id: "demo-5", label: "Research", kind: "chat_gpt", email: "morgan@example.org", workspace_name: "Research", plan_type: "team", active: false },
  { id: "demo-6", label: "Personal", kind: "chat_gpt", email: "casey@example.net", workspace_name: "Personal", plan_type: "free", active: false },
];

const quotaValues = [
  [72, 38], [44, 81], [100, 16], [23, 61], [0, 7], [68],
];
const quotas = Object.fromEntries(accounts.map((account, index) => {
  const values = quotaValues[index]!;
  const windows: NonNullable<QuotaView["snapshot"]>["buckets"][number]["windows"] = index === 5
    ? [{ kind: "other", window_duration_mins: 43_200, remaining_percent: values[0], used_percent: 100 - values[0]!, resets_at: at(30, 16, 30) }]
    : [
      { kind: "five_hour", window_duration_mins: 300, remaining_percent: values[0], used_percent: 100 - values[0]!, resets_at: at(26, 12, 30) },
      { kind: "weekly", window_duration_mins: 10_080, remaining_percent: values[1], used_percent: 100 - values[1]!, resets_at: at(29, 9, 45) },
    ];
  const quota: QuotaView = {
    account_id: account.id,
    status: "fresh",
    snapshot: {
      fetched_at_unix_ms: fixedNow,
      buckets: [{ limit_id: "codex", kind: "codex", windows }],
      reset_credits: { available_count: index === 5 ? 0 : 2, nearest_expiry: at(30, 16, 30), details_available: true, can_redeem: index !== 5, usable_credits: [] },
    },
  };
  return [account.id, quota];
})) as Record<string, QuotaView>;

const snapshot: AppSnapshot = {
  storage: { status: "ready" },
  accounts,
  live: { status: "ready", credential_store: "file", account: accounts[0] },
};

let invokeSettings: InvokeSettings = {
  invoke_mode: true,
  claude_setup: {
    setup: "claude-codex",
    router: {
      mode: "mixed",
      claudeAllowed: {
        haiku: ["low", "medium"],
        sonnet: ["low", "medium", "high", "xhigh", "max"],
        opus: ["low", "medium", "high", "xhigh", "max"],
      },
      claudeOnlyReview: "on",
    },
  },
  allowed_invocation_profiles: [{ model: "gpt-6-sol", reasoning_efforts: ["low", "medium", "high"] }],
  task_defaults: {
    review: { model: "gpt-6-sol", effort: "high" },
    research: { model: "gpt-6-sol", effort: "medium" },
  },
  account_priority: ["demo-1", "demo-3", "demo-4"],
  preferred_min_remaining: 20,
  max_concurrent_tasks: 2,
};

const displayOnly = {
  appSnapshot: async () => snapshot,
  accountQuota: async (id: string) => quotas[id] || { account_id: id, status: "unknown" },
  codexCliInfo: async () => ({ version: "0.158.0", latest_version: "0.158.0", supports_update: true, update_status: "current" as const }),
  invokeSettings: async () => invokeSettings,
  setClaudeSetup: async (setup: ClaudeSetup) => {
    invokeSettings = {
      ...invokeSettings,
      claude_setup: structuredClone(setup),
      invoke_mode: setup.setup === "claude-codex" || (setup.setup === "router"
        && (setup.router.mode !== "claude" || setup.router.claudeOnlyReview === "on")),
    };
    return invokeSettings;
  },
  onInvokeAccountSwitched: async () => () => undefined,
  invokeFailover: async () => null,
  onInvokeFailoverWaiting: async () => () => undefined,
  invokePause: async () => null,
  updateDelivery: async () => "installer_exits" as const,
  appVersion: async () => ({ version: "1.12.0", dev: false }),
  onInvokePaused: async () => () => undefined,
  onInvokeAutoWoke: async () => () => undefined,
  stopInvokeTask: async () => undefined,
  invokeTasks: async () => [
    { id: "demo-task-1", started_at: Date.now() - 4 * 60_000 - 12_000, model: "gpt-6.1-sol", reasoning_effort: "medium", write: true, cwd: "C:/work/studio-app", thread_id: "01a1f2c3-demo", running: true },
    { id: "demo-task-2", started_at: Date.now() - 40_000, model: "gpt-6-luna", reasoning_effort: "low", write: false, cwd: "C:/work/studio-app", thread_id: "01a1f2c4-demo", running: true },
  ],
  pausedThreads: async () => [],
  readTaskLog: async (_threadId: string, offset: number) => offset > 0
    ? { found: true, items: [], offset }
    : {
      found: true,
      offset: 1,
      items: [
        { kind: "task", text: "Add removeItem(cart, name) to cart.js with tests, matching the existing style." },
        { kind: "message", text: "I'll read the module and its tests first, then add removeItem and focused tests." },
        { kind: "command", text: "Get-Content -Raw cart.js; Get-Content -Raw cart.test.js; git status --short" },
        { kind: "output", text: "// A tiny shopping cart.\nfunction addItem(cart, name, price, quantity) {\n  ...\n}" },
        { kind: "patch", files: ["cart.js", "cart.test.js"] },
        { kind: "command", text: "node --test" },
        { kind: "output", text: "✔ addItem and total keep working (1.9ms)\n✔ removeItem removes only the named item (0.4ms)\nℹ pass 6\nℹ fail 0" },
        { kind: "tokens", total: 55245, input_tokens: 51000, cached_input_tokens: 45000, output_tokens: 4245, reasoning_output_tokens: 400, total_tokens: 55245 },
      ],
    },
  activity: async () => [
    { at: Date.now() - 4 * 60_000, kind: "task_started", task: "demo-task-1", model: "gpt-6.1-sol", effort: "medium", write: true, cwd: "C:/work/studio-app" },
    { at: Date.now() - 53 * 60_000, kind: "task_started", task: "demo-task-0", model: "gpt-6-luna", effort: "low", write: false, cwd: "C:/work/studio-app" },
    { at: Date.now() - 9 * 60_000, kind: "switched", from: "demo-3", to: "demo-1", reason: "priority" },
    { at: Date.now() - 31 * 60_000, kind: "woke", accounts: ["demo-4"] },
    { at: Date.now() - 52 * 60_000, kind: "task_ended", task: "demo-task-0", model: "gpt-6-luna", thread_id: "01a1e9b8-demo", status: "completed", usage: { input_tokens: 30000, cached_input_tokens: 25000, output_tokens: 11200, reasoning_output_tokens: 400, total_tokens: 41200 } },
  ],
  onInvokeActivity: async () => () => undefined,
  onInvokeResumed: async () => () => undefined,
  modelCatalog: async () => [
    { model: "gpt-6-astra", display_name: "gpt-6-astra", supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], is_default: true },
    { model: "gpt-6-sol", display_name: "gpt-6-sol", supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], is_default: false },
    { model: "gpt-5.5", display_name: "gpt-5.5", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], is_default: false },
  ],
};

// The proxy deliberately rejects API operations absent from the display mock.
export const api = new Proxy(displayOnly, {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    throw new Error(`The README demo forbids operation ${String(property)}.`);
  },
}) as unknown as typeof import("../src/api").api;
export type UpdateDelivery = import("../src/api").UpdateDelivery;
