// Added by Light505 for gswitchtool (2026).
import fs from "node:fs";
import path from "node:path";
import { efforts, workerNames, difficulties, kinds, failureReasons, workerFailures, tokenPrices } from "./workers.mjs";

export { difficulties } from "./workers.mjs";
const reasons = failureReasons;
const outcomes = ["pass", "fail", "unverified", "blocked"];
const steps = ["start", "escalation", "repair", "retry"];
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const firstNumber = (...values) => values.find(number) ?? null;
const text = (value) => typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

export function isResultWorker(worker, namespace = "router") {
  if (typeof worker !== "string") return false;
  if (workerNames.some((name) => worker === `${namespace}:${name}`)) return true;
  const codex = worker.match(/^(codex(?:-dev)?):([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([a-z]+)$/);
  return !!codex && efforts.includes(codex[3]) && (codex[1] === "codex" || namespace === "router-dev");
}

// One O_APPEND write per record; callers serialize writes with the router lock.
export function appendResult(file, record) {
  const json = JSON.stringify(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a+", 0o600);
  try {
    // An interrupted last record must not swallow the next appended record.
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(1);
    const needsNewline = size > 0 && fs.readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10;
    const line = Buffer.from(`${needsNewline ? "\n" : ""}${json}\n`, "utf8");
    if (fs.writeSync(fd, line) !== line.length) throw new Error("Incomplete results log write");
  } finally { fs.closeSync(fd); }
}

export function readResults(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {} // Keep reading after an interrupted or corrupt record.
  }
  return records;
}

function flags(args, names) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!names.includes(flag) || Object.hasOwn(values, flag)) throw new Error("Unknown or duplicate option");
    if (!text(value) || value.startsWith("--")) throw new Error(`Missing or invalid value for ${flag}`);
    values[flag] = value;
  }
  return values;
}

function choice(f, flag, allowed) {
  if (f[flag] === undefined) return null;
  if (!allowed.includes(f[flag])) throw new Error("Invalid " + flag.slice(2) + ". Valid values: " + allowed.join(", "));
  return f[flag];
}
function integer(f, flag, min, max) {
  if (f[flag] === undefined) return null;
  if (!/^\d+$/.test(f[flag]) || Number(f[flag]) < min || Number(f[flag]) > max)
    throw new Error(flag + " requires an integer " + min + "–" + max);
  return Number(f[flag]);
}
function yesNo(f, flag) {
  const value = choice(f, flag, ["yes", "no"]);
  return value === null ? null : value === "yes";
}

export function resultRecord(args, normalizeProject, namespace = "router") {
  const [sessionId, directory, ...rest] = args;
  if (!text(sessionId) || sessionId.startsWith("--") || !text(directory) || directory.startsWith("--")) {
    throw new Error("result requires <sessionId> <projectDir>");
  }
  const f = flags(rest, ["--task", "--difficulty", "--worker", "--outcome", "--reason", "--step", "--title", "--agent", "--codex-job", "--codex-thread", "--review", "--findings"]);
  if (!f["--task"]) throw new Error("result requires --task <id>");
  if (!difficulties.includes(f["--difficulty"])) throw new Error(`Invalid difficulty. Valid values: ${difficulties.join(", ")}`);
  const orchestrator = f["--worker"] === "orchestrator";
  if (!orchestrator && !isResultWorker(f["--worker"], namespace)) throw new Error("Invalid worker. Use a router worker, codex:<model>/<effort> (low, medium, high, xhigh, max) or orchestrator");
  if (orchestrator && (f["--agent"] || f["--codex-job"] || f["--codex-thread"])) throw new Error("Orchestrator results cannot use --agent, --codex-job or --codex-thread");
  if (!outcomes.includes(f["--outcome"])) throw new Error("Invalid outcome. Valid values: pass, fail, unverified, blocked");
  if (f["--reason"] && !reasons.includes(f["--reason"])) throw new Error(`Invalid reason. Valid values: ${reasons.join(", ")}`);
  if (f["--outcome"] === "fail" && !f["--reason"]) throw new Error(`A failed result needs --reason ${reasons.join(", ")}`);
  if (f["--step"] && !steps.includes(f["--step"])) throw new Error("Invalid step. Valid values: start, escalation, repair, retry");
  if (f["--title"] && [...f["--title"]].length > 120) throw new Error("Title must be at most 120 characters");
  return {
    type: "result", time: new Date().toISOString(), sessionId, project: normalizeProject(directory),
    task: f["--task"], difficulty: f["--difficulty"], worker: f["--worker"], outcome: f["--outcome"],
    review: choice(f, "--review", ["none", "minor", "serious"]), findings: integer(f, "--findings", 0, 99),
    reason: f["--reason"] ?? null, step: f["--step"] ?? null, title: f["--title"] ?? null,
    agentId: f["--agent"] ?? null, codexJobId: f["--codex-job"] ?? null, codexThreadId: f["--codex-thread"] ?? null
  };
}

export function planRecord(args, normalizeProject) {
  const [sessionId, directory, ...rest] = args;
  if (!text(sessionId) || sessionId.startsWith("--") || !text(directory) || directory.startsWith("--")) throw new Error("plan requires <sessionId> <projectDir>");
  const f = flags(rest, ["--task", "--kind", "--difficulty", "--title", "--codex", "--files", "--cross-module", "--check", "--repro", "--confidence"]);
  if (!/^[\w.-]{1,40}$/.test(f["--task"] ?? "")) throw new Error("Invalid task id. Use 1–40 letters, digits, underscores, dots or hyphens");
  if (!kinds.includes(f["--kind"])) throw new Error(`Invalid kind. Valid values: ${kinds.join(", ")}`);
  if (!difficulties.includes(f["--difficulty"])) throw new Error(`Invalid difficulty. Valid values: ${difficulties.join(", ")}`);
  if (f["--title"] && [...f["--title"]].length > 120) throw new Error("Title must be at most 120 characters");
  return { type: "plan", time: new Date().toISOString(), sessionId, project: normalizeProject(directory),
    files: integer(f, "--files", 1, 999), crossModule: yesNo(f, "--cross-module"),
    check: choice(f, "--check", ["test", "build", "review", "none"]), repro: yesNo(f, "--repro"),
    confidence: choice(f, "--confidence", ["high", "medium", "low"]),
    task: f["--task"], kind: f["--kind"], difficulty: f["--difficulty"], title: f["--title"] ?? null, codex: f["--codex"] ?? null };
}
export function taskState(records, sessionId, task) {
  const matching = records.filter((r) => r.sessionId === sessionId && r.task === task);
  const results = matching.filter((r) => r.type === "result" && r.worker !== "orchestrator");
  const failed = results.filter((r) => r.outcome === "fail"), workers = new Map();
  for (const r of failed) {
    if (r.sample !== true && r.reason != null && !workerFailures.includes(r.reason)) continue;
    const reasons = workers.get(r.worker) ?? [];
    if (!reasons.includes(r.reason ?? "other")) reasons.push(r.reason ?? "other");
    workers.set(r.worker, reasons);
  }
  // Done when the latest result passed and no later review found a serious problem (that reopens the task).
  const last = results.at(-1), after = matching.indexOf(last);
  const done = !!last && ["pass", "unverified"].includes(last.outcome) &&
    !matching.some((r, i) => i > after && r.type === "review" && r.review === "serious");
  return { hasResults: matching.some((r) => r.type === "result"), plan: matching.filter((r) => r.type === "plan").at(-1) ?? null, results, failures: failed.length,
    done,
    failedWorkers: [...workers].map(([worker, reasons]) => ({ worker, reasons,
      sample: failed.filter((r) => r.worker === worker && (r.sample === true || r.reason == null || workerFailures.includes(r.reason))).every((r) => r.sample === true) })), last: results.at(-1) ?? null };
}

export function parseSelfReport(text) {
  if (typeof text !== "string") return null;
  const line = text.split(/\r?\n/).filter((line) => line.startsWith("RESULT:")).at(-1);
  if (line === undefined) return null;
  const parts = line.slice(7).split(/[·|;,]/).map((part) => part.trim());
  const fields = Object.fromEntries(parts.filter((part) => part.includes(":")).map((part) => {
    const at = part.indexOf(":"); return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
  return { status: ["done", "partial", "stopped"].includes(parts[0]) ? parts[0] : null,
    confidence: ["high", "medium", "low"].includes(fields.confidence) ? fields.confidence : null,
    felt: difficulties.includes(fields.felt) ? fields.felt : null,
    verifyFails: /^\d+$/.test(fields["verify-fails"] ?? "") && Number.isSafeInteger(Number(fields["verify-fails"])) ? Number(fields["verify-fails"]) : null };
}

export function transcriptText(file) {
  try {
    const entries = fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => { try { return object(JSON.parse(line)); } catch { return {}; } });
    const message = object(entries.filter((entry) => entry.type === "assistant").at(-1)?.message);
    return typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
  } catch { return ""; }
}

function usageTokens(value) {
  if (number(value)) return value;
  const u = object(value);
  const total = firstNumber(u.totalTokens, u.total_tokens);
  if (total !== null) return total;
  // Claude usage splits input/output and may report cache tokens separately.
  const parts = [u.input_tokens ?? u.inputTokens, u.output_tokens ?? u.outputTokens,
    u.cache_read_input_tokens, u.cache_creation_input_tokens].filter(number);
  return parts.length ? parts.reduce((sum, part) => sum + part, 0) : null;
}

export function attemptRecord(input, { sessionId, project, agentId = null, worker, scope = [], task = null }) {
  const response = object(input.tool_response);
  return {
    type: "attempt", time: new Date().toISOString(), sessionId: sessionId ?? null, project, agentId, worker, scope, task,
    durationMs: firstNumber(response.totalDurationMs, response.duration_ms),
    tokens: firstNumber(response.totalTokens, usageTokens(response.usage), usageTokens(input.usage)),
    raw: { input: Object.keys(input), tool_response: Object.keys(response) }
  };
}

// The worker's total so far. A segment starts at the brief and at each coordinator message (a resume or a
// message while it runs), so idle time between a stop and a resume is not counted. promptId is not used: it is the orchestrator's.
export function transcriptTotals(file) {
  let entries;
  try { entries = fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => { try { return object(JSON.parse(line)); } catch { return {}; } }); }
  catch { return null; }
  const brief = entries.findIndex((entry) => entry.type === "user" && entry.isMeta !== true && typeof object(entry.message).content === "string");
  if (brief < 0) return null;
  const starts = entries.map((_, i) => i).filter((i) => i === brief ||
    (i > brief && object(entries[i].origin).kind === "coordinator" && typeof object(entries[i].message).content === "string"));
  const spans = starts.map((start, i) => {
    const times = entries.slice(start, starts[i + 1] ?? entries.length).map((entry) => Date.parse(entry.timestamp)).filter(Number.isFinite);
    return times.length ? times.at(-1) - times[0] : null;
  }).filter(number);
  // One API response is written as several lines with the same message ID and usage.
  const messages = new Map();
  for (const entry of entries) {
    const message = object(entry.message);
    if (entry.type === "assistant" && typeof message.id === "string" && message.usage) messages.set(message.id, message);
  }
  const usages = [...messages.values()].map((message) => object(message.usage));
  const sum = (field) => usages.reduce((total, usage) => total + (number(usage[field]) ? usage[field] : 0), 0);
  const inputTokens = sum("input_tokens"), cacheCreationTokens = sum("cache_creation_input_tokens"), cacheReadTokens = sum("cache_read_input_tokens"), outputTokens = sum("output_tokens");
  let usd = null;
  for (const message of messages.values()) {
    if (!Object.hasOwn(tokenPrices, message.model)) { usd = null; break; }
    const usage = object(message.usage), count = (field) => number(usage[field]) ? usage[field] : 0;
    const input = count("input_tokens"), write = count("cache_creation_input_tokens"), read = count("cache_read_input_tokens");
    const base = tokenPrices[message.model];
    const price = input + write + read > 100_000 && base.above100k ? base.above100k : base;
    const split = object(usage.cache_creation);
    const hasSplit = number(split.ephemeral_5m_input_tokens) || number(split.ephemeral_1h_input_tokens);
    const write5m = hasSplit ? firstNumber(split.ephemeral_5m_input_tokens, 0) : write;
    const write1h = hasSplit ? firstNumber(split.ephemeral_1h_input_tokens, 0) : 0;
    usd = (usd ?? 0) + (input * price.input + write5m * price.cacheWrite + write1h * price.cacheWrite1h + read * price.cachedInput + count("output_tokens") * price.output) / 1_000_000;
  }
  return { durationMs: spans.length ? spans.reduce((total, span) => total + span, 0) : null,
    inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens,
    tokens: messages.size ? inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens : null,
    models: [...new Set([...messages.values()].map((message) => message.model).filter(text))], usd };
}

export function validResult(record) {
  return record.type === "result" && text(record.sessionId) && text(record.project) && text(record.task) && text(record.worker) &&
    isResultWorker(record.worker, /^(router-dev|codex-dev):/.test(record.worker) ? "router-dev" : "router") &&
    difficulties.includes(record.difficulty) && outcomes.includes(record.outcome) &&
    typeof record.time === "string" && Number.isFinite(Date.parse(record.time));
}

const median = (values) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b), mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};
const identity = (record) => JSON.stringify([record.sessionId, record.worker, record.agentId]);
const codexWorker = (worker) => /^codex(?:-dev)?:/.test(worker);
const runIndex = (runs) => new Map(runs.filter((r) => text(r.jobId)).map((r) => [r.jobId, r]));
const selected = (r, { project, since, now = Date.now(), normalizeProject = (value) => value }) =>
  validResult(r) && r.outcome !== "blocked" && (!project || normalizeProject(r.project) === normalizeProject(project)) &&
  (since === undefined || Date.parse(r.time) >= now - since * 86400000);

export function aggregateStats(records, options = {}) {
  const runs = runIndex(options.codexRuns ?? []);
  const telemetry = new Map();
  for (const r of records) {
    if (r.type !== "attempt" || !text(r.sessionId) || !text(r.project) || !text(r.worker) || !text(r.agentId)) continue;
    // Stop and tool completion describe one attempt. Transcript totals are cumulative, so the latest supplied value wins; an empty record never erases it.
    const key = identity(r), previous = telemetry.get(key) || {};
    telemetry.set(key, { durationMs: firstNumber(r.durationMs, previous.durationMs), tokens: firstNumber(r.tokens, previous.tokens), usd: firstNumber(r.usd, previous.usd) });
  }
  const groups = new Map();
  for (const r of records) {
    if (!selected(r, options)) continue;
    const codex = codexWorker(r.worker), run = codex && text(r.codexJobId) ? runs.get(r.codexJobId) : undefined;
    const speed = ["fast", "normal", "mixed"].includes(run?.speed) ? run.speed : "-";
    const key = JSON.stringify([r.worker, r.difficulty, speed]);
    const group = groups.get(key) || { worker: r.worker, difficulty: r.difficulty, speed, attempts: 0, passes: 0, durations: [], tokens: [], usd: [], jobs: new Set() };
    group.attempts++;
    if (["pass", "unverified"].includes(r.outcome)) group.passes++;
    const attempt = codex ? { durationMs: run?.codexMs, tokens: run?.tokens } : text(r.agentId) ? telemetry.get(identity(r)) : undefined;
    if (number(attempt?.durationMs)) group.durations.push(attempt.durationMs);
    if (number(attempt?.tokens)) group.tokens.push(attempt.tokens);
    if (number(attempt?.usd)) group.usd.push(attempt.usd);
    if (/^codex(?:-dev)?:/.test(r.worker) && text(r.codexJobId)) group.jobs.add(r.codexJobId);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.worker.localeCompare(b.worker) || difficulties.indexOf(a.difficulty) - difficulties.indexOf(b.difficulty) || a.speed.localeCompare(b.speed))
    .map((g) => ({ worker: g.worker, difficulty: g.difficulty, speed: g.speed, attempts: g.attempts, passes: g.passes,
      successRate: g.passes / g.attempts, medianDurationMs: median(g.durations), medianTokens: median(g.tokens), medianUsd: median(g.usd), linkedJobs: g.jobs.size }));
}

// Orchestrator edits are logged as results but are not worker attempts, so aggregateStats and validResult skip them.
export function orchestratorEdits(records, { project, since, now = Date.now(), normalizeProject = (value) => value } = {}) {
  return records.filter((r) => r.type === "result" && r.worker === "orchestrator" && text(r.sessionId) && text(r.project) && text(r.task) &&
    difficulties.includes(r.difficulty) && outcomes.includes(r.outcome) && typeof r.time === "string" && Number.isFinite(Date.parse(r.time)) &&
    (!project || normalizeProject(r.project) === normalizeProject(project)) &&
    (since === undefined || Date.parse(r.time) >= now - since * 86400000)).length;
}

export function statsOptions(args, normalizeProject) {
  const f = flags(args, ["--project", "--since"]);
  const since = f["--since"] === undefined ? undefined : Number(f["--since"]);
  if (since !== undefined && (!/^\d+(?:\.\d+)?$/.test(f["--since"]) || !number(since))) throw new Error("--since requires nonnegative days");
  return { project: f["--project"] ? normalizeProject(f["--project"]) : undefined, since, normalizeProject };
}

// Same plain names as the GSwitch app's Results screen.
const codexNames = { "gpt-6.1-sol": "Codex Sol 6.1", "gpt-6-luna": "Codex Luna 6" };
const claudeNames = { haiku: "Claude Haiku", sonnet: "Claude Sonnet", opus: "Claude Opus" };
export function modelName(worker) {
  const [, family, rest] = /^(router|router-dev|codex|codex-dev):(.+)$/.exec(worker) ?? [];
  if (!family) return worker;
  if (family.startsWith("codex")) {
    const [model, effort] = rest.split("/");
    const name = codexNames[model] ?? model;
    return effort ? `${name}, ${effort}` : name;
  }
  const split = rest.lastIndexOf("-"), model = split < 0 ? rest : rest.slice(0, split), effort = split < 0 ? "" : rest.slice(split + 1);
  const name = claudeNames[Object.keys(claudeNames).find((key) => model.toLowerCase().includes(key))] ?? model;
  return effort ? `${name}, ${effort}` : name;
}
const plainTime = (ms) => {
  if (!number(ms)) return "-";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
};

const plainTokens = (n) => !number(n) ? "-" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

export function statsTable(groups) {
  const rows = [["Model", "Difficulty", "Codex speed", "Tasks", "Passed", "Success", "Typical time", "Typical tokens", "Typical cost", "Codex jobs"],
    ...groups.map((g) => [modelName(g.worker), g.difficulty, g.speed === "-" ? "-" : g.speed[0].toUpperCase() + g.speed.slice(1), String(g.attempts), String(g.passes), `${(g.successRate * 100).toFixed(1)}%`,
      plainTime(g.medianDurationMs), plainTokens(g.medianTokens), number(g.medianUsd) ? `$${g.medianUsd.toFixed(2)}` : "-", /^codex(?:-dev)?:/.test(g.worker) ? String(g.linkedJobs) : "-"])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

// Compare finished jobs once each, pooling times across the selected difficulties.
export function speedComparisons(records, options = {}) {
  const runs = runIndex(options.codexRuns ?? []), workers = new Map();
  for (const r of records) {
    if (!selected(r, options) || !codexWorker(r.worker)) continue;
    const run = runs.get(r.codexJobId);
    if (!["fast", "normal"].includes(run?.speed) || !number(run.codexMs)) continue;
    const jobs = workers.get(r.worker) ?? new Map();
    jobs.set(r.codexJobId, run); workers.set(r.worker, jobs);
  }
  const lines = [];
  for (const [worker, jobs] of [...workers].sort(([a], [b]) => a.localeCompare(b))) {
    const times = (speed) => [...jobs.values()].filter((r) => r.speed === speed).map((r) => r.codexMs);
    const fast = times("fast"), normal = times("normal"), f = median(fast), n = median(normal);
    if (!fast.length || !normal.length || f === 0 || n === 0) continue;
    const faster = n >= f, ratio = faster ? n / f : f / n;
    lines.push(`Fast vs Normal, ${modelName(worker)}:${fast.length} fast, median ${(f / 1000).toFixed(1)}s · ${normal.length} normal, median ${(n / 1000).toFixed(1)}s · ${ratio.toFixed(2)}x ${faster ? "faster" : "slower"}`);
  }
  return lines;
}
