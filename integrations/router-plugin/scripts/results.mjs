// Added by Light505 for gswitchtool (2026).
import fs from "node:fs";
import path from "node:path";
import { efforts, workerNames } from "./workers.mjs";

export const difficulties = ["trivial", "small", "moderate", "hard", "high-risk"];
const reasons = ["verify", "review", "scope", "stopped", "other"];
const steps = ["start", "escalation"];
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

export function resultRecord(args, normalizeProject, namespace = "router") {
  const [sessionId, directory, ...rest] = args;
  if (!text(sessionId) || sessionId.startsWith("--") || !text(directory) || directory.startsWith("--")) {
    throw new Error("result requires <sessionId> <projectDir>");
  }
  const f = flags(rest, ["--task", "--difficulty", "--worker", "--outcome", "--reason", "--step", "--title", "--agent", "--codex-job", "--codex-thread"]);
  if (!f["--task"]) throw new Error("result requires --task <id>");
  if (!difficulties.includes(f["--difficulty"])) throw new Error(`Invalid difficulty. Valid values: ${difficulties.join(", ")}`);
  if (!isResultWorker(f["--worker"], namespace)) throw new Error("Invalid worker. Use a router worker or codex:<model>/<effort> (low, medium, high, xhigh, max)");
  if (!["pass", "fail"].includes(f["--outcome"])) throw new Error("Invalid outcome. Valid values: pass, fail");
  if (f["--reason"] && !reasons.includes(f["--reason"])) throw new Error(`Invalid reason. Valid values: ${reasons.join(", ")}`);
  if (f["--step"] && !steps.includes(f["--step"])) throw new Error("Invalid step. Valid values: start, escalation");
  if (f["--title"] && [...f["--title"]].length > 120) throw new Error("Title must be at most 120 characters");
  return {
    type: "result", time: new Date().toISOString(), sessionId, project: normalizeProject(directory),
    task: f["--task"], difficulty: f["--difficulty"], worker: f["--worker"], outcome: f["--outcome"],
    reason: f["--reason"] ?? null, step: f["--step"] ?? null, title: f["--title"] ?? null,
    agentId: f["--agent"] ?? null, codexJobId: f["--codex-job"] ?? null, codexThreadId: f["--codex-thread"] ?? null
  };
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

export function attemptRecord(input, { sessionId, project, agentId = null, worker, scope = [] }) {
  const response = object(input.tool_response);
  return {
    type: "attempt", time: new Date().toISOString(), sessionId: sessionId ?? null, project, agentId, worker, scope,
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
  return { durationMs: spans.length ? spans.reduce((total, span) => total + span, 0) : null,
    inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens,
    tokens: messages.size ? inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens : null,
    models: [...new Set([...messages.values()].map((message) => message.model).filter(text))] };
}

export function validResult(record) {
  return record.type === "result" && text(record.sessionId) && text(record.project) && text(record.task) && text(record.worker) &&
    isResultWorker(record.worker, /^(router-dev|codex-dev):/.test(record.worker) ? "router-dev" : "router") &&
    difficulties.includes(record.difficulty) && ["pass", "fail"].includes(record.outcome) &&
    typeof record.time === "string" && Number.isFinite(Date.parse(record.time));
}

const median = (values) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b), mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};
const identity = (record) => JSON.stringify([record.sessionId, record.worker, record.agentId]);
export function aggregateStats(records, { project, since, now = Date.now(), normalizeProject = (value) => value } = {}) {
  const telemetry = new Map();
  for (const r of records) {
    if (r.type !== "attempt" || !text(r.sessionId) || !text(r.project) || !text(r.worker) || !text(r.agentId)) continue;
    // Stop and tool completion describe one attempt. Transcript totals are cumulative, so the latest supplied value wins; an empty record never erases it.
    const key = identity(r), previous = telemetry.get(key) || {};
    telemetry.set(key, { durationMs: firstNumber(r.durationMs, previous.durationMs), tokens: firstNumber(r.tokens, previous.tokens) });
  }
  const groups = new Map();
  for (const r of records) {
    if (!validResult(r) || (project && normalizeProject(r.project) !== normalizeProject(project)) ||
        (since !== undefined && Date.parse(r.time) < now - since * 86400000)) continue;
    const key = JSON.stringify([r.worker, r.difficulty]);
    const group = groups.get(key) || { worker: r.worker, difficulty: r.difficulty, attempts: 0, passes: 0, durations: [], tokens: [], jobs: new Set() };
    group.attempts++;
    if (r.outcome === "pass") group.passes++;
    const attempt = text(r.agentId) ? telemetry.get(identity(r)) : undefined;
    if (number(attempt?.durationMs)) group.durations.push(attempt.durationMs);
    if (number(attempt?.tokens)) group.tokens.push(attempt.tokens);
    if (/^codex(?:-dev)?:/.test(r.worker) && text(r.codexJobId)) group.jobs.add(r.codexJobId);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.worker.localeCompare(b.worker) || difficulties.indexOf(a.difficulty) - difficulties.indexOf(b.difficulty))
    .map((g) => ({ worker: g.worker, difficulty: g.difficulty, attempts: g.attempts, passes: g.passes,
      successRate: g.passes / g.attempts, medianDurationMs: median(g.durations), medianTokens: median(g.tokens), linkedJobs: g.jobs.size }));
}

export function statsOptions(args, normalizeProject) {
  const f = flags(args, ["--project", "--since"]);
  const since = f["--since"] === undefined ? undefined : Number(f["--since"]);
  if (since !== undefined && (!/^\d+(?:\.\d+)?$/.test(f["--since"]) || !number(since))) throw new Error("--since requires nonnegative days");
  return { project: f["--project"] ? normalizeProject(f["--project"]) : undefined, since, normalizeProject };
}

export function statsTable(groups) {
  const rows = [["Worker", "Difficulty", "Attempts", "Passes", "Success", "Median ms", "Median tokens", "Codex jobs"],
    ...groups.map((g) => [g.worker, g.difficulty, String(g.attempts), String(g.passes), `${(g.successRate * 100).toFixed(1)}%`,
      String(g.medianDurationMs ?? "-"), String(g.medianTokens ?? "-"), /^codex(?:-dev)?:/.test(g.worker) ? String(g.linkedJobs) : "-"])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}
