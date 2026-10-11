// Added by Light505 for gswitchtool (2026).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { directoryName, appDataDirectory } from "./setup.mjs";
import { models, efforts, prefers, workerNames, defaultAllowed, needsApproval, workerTable, benchmarks, benchmarkId, taskFloor, candidates, ownerCheckAfter, kinds, difficulties } from "./workers.mjs";
import { appendResult, readResults, resultRecord, planRecord, parseSelfReport, transcriptText, taskState, attemptRecord, transcriptTotals, aggregateStats, orchestratorEdits, statsOptions, statsTable, speedComparisons } from "./results.mjs";
import { readInvokeStatus, invokeState, codexAllowedFrom } from "./gswitch-client.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modes = ["off", "mixed", "codex", "claude"];
const reviews = ["on", "off"];
const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function readJSON(file, fallback = {}) {
  try { return object(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))); }
  catch { return fallback; }
}
const target = readJSON(path.join(pluginRoot, "router-target.json"));
const dataName = directoryName(target.dataDir, ".gswitchtool-router");
const dataDir = path.join(home, dataName);
const setupFile = path.join(appDataDirectory(home, target), "claude-setup.json");
const pluginName = readJSON(path.join(pluginRoot, ".claude-plugin", "plugin.json")).name || "router";
const data = (...parts) => path.join(dataDir, ...parts);
const routerScript = path.join(pluginRoot, "scripts", "router.mjs");
// One status request per process; any failure reads as unknown.
let statusRequest;
const invokeStatus = () => statusRequest ??= readInvokeStatus(appDataDirectory(home, target)).catch(() => null);

function atomicJSON(file, value, indent = 2, newline = "\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, indent).replace(/\n/g, newline)}${newline}`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Serialize read/modify/write across hook processes, not merely each rename.
async function locked(action, name = "state.lock", stale = 60000, wait = 10000) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = data(name);
  const started = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A terminated hook must not permanently prevent state updates.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > stale) fs.rmdirSync(lock); } catch {}
      if (Date.now() - started > wait) throw new Error("Router state is busy");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { fs.rmdirSync(lock); }
}

export function projectKey(directory, platform = process.platform) {
  const slashes = String(directory || process.cwd()).replace(/\\/g, "/");
  const absolute = platform === "win32" ? path.win32.resolve(slashes).replace(/\\/g, "/") : path.resolve(slashes);
  return absolute.replace(/\/+$/, "");
}
function comparable(directory) {
  const key = projectKey(directory);
  return process.platform === "win32" ? key.toLowerCase() : key;
}
function claudeAllowed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultAllowed();
  const allowed = {};
  for (const { short } of models) {
    if (!Object.hasOwn(value, short)) continue;
    if (!Array.isArray(value[short]) || value[short].some((effort) => typeof effort !== "string")) return defaultAllowed();
    allowed[short] = efforts.filter((effort) => value[short].includes(effort));
  }
  return allowed;
}
function allowedList(allowed = config().claudeAllowed, capitalize = false) {
  return models.filter(({ short }) => allowed[short]?.length)
    .map(({ short }) => `${capitalize ? short[0].toUpperCase() + short.slice(1) : short} ${allowed[short].join(", ")}`).join(" · ") || "none";
}
export function normalizeCodexSpeed(value) {
  return { mode: ["normal", "fast", "orchestrator"].includes(value?.mode) ? value.mode : "normal",
    fastMinRemaining: Number.isInteger(value?.fastMinRemaining) && value.fastMinRemaining >= 0 && value.fastMinRemaining <= 90
      ? value.fastMinRemaining : 20 };
}
// The session size (tokens) at which a session hands off to a new one; anything else means 250000.
export const normalizeSessionLimit = (value) => Number.isInteger(value) && value >= 100000 && value <= 1000000 ? value : 250000;
function config() {
  const setup = readJSON(setupFile);
  const valid = setup.version === 1 && ["claude-only", "claude-codex", "router"].includes(setup.setup) &&
    modes.slice(1).includes(setup.router?.mode) && reviews.includes(setup.router?.claudeOnlyReview);
  const value = valid ? setup.router : {};
  return { mode: valid && setup.setup === "router" ? value.mode : "off",
    codexSpeed: normalizeCodexSpeed(setup.codexSpeed), sessionLimit: normalizeSessionLimit(setup.sessionLimit),
    prefer: prefers.includes(value.prefer) ? value.prefer : "codex",
    sampling: value.sampling === "off" ? "off" : "on",
    claudeOnlyReview: value.claudeOnlyReview ?? "on", claudeAllowed: claudeAllowed(value.claudeAllowed) };
}
// Only status-line passthrough state remains in the router's old config file.
function statuslineConfig() {
  const { statusLinePrevious, statusLineCommand } = readJSON(data("config.json"));
  return { statusLinePrevious, statusLineCommand };
}
const safeName = (id) => /^[\w-]+$/.test(id) ? id : hash(id);
function sessionFile(id) {
  if (!id) throw new Error("A session ID is required");
  return data("sessions", `${safeName(id)}.json`);
}
function session(id) {
  const { mode: _mode, claudeOnlyReview: _review, ...value } = id ? readJSON(sessionFile(id)) : {};
  return { ...value, pending: Array.isArray(value.pending) ? value.pending : [],
    codexLaunches: Array.isArray(value.codexLaunches) ? value.codexLaunches : [],
    bindings: object(value.bindings), finished: Array.isArray(value.finished) ? value.finished : [] };
}
function saveSession(id, value) { atomicJSON(sessionFile(id), { ...value, updatedAt: new Date().toISOString() }); }
function resolved() {
  const cfg = config();
  return { mode: { value: cfg.mode, source: "GSwitch setup" },
    review: { value: cfg.claudeOnlyReview, source: "GSwitch setup" }, prefer: cfg.prefer, codexSpeed: cfg.codexSpeed };
}
function routerLine(state) {
  if (state.mode.value === "off") return "Automatic team is off";
  const label = { mixed: "Claude and Codex", codex: "Codex only", claude: "Claude models only" }[state.mode.value];
  const prefer = { codex: "Codex", claude: "Claude", price: "Cheapest" }[state.prefer];
  const speed = { normal: "Normal", fast: "Fast", orchestrator: "Claude decides" }[state.codexSpeed.mode];
  return `Automatic team · ${label}${state.mode.value === "mixed" ? ` · Try first: ${prefer}` : ""}${["mixed", "codex"].includes(state.mode.value) ? ` · Codex speed: ${speed}` : ""} · Codex reviews: ${state.review.value}`;
}
function resetMilliseconds(value) {
  return typeof value === "number" ? value * 1000 : Date.parse(value);
}
function usage() {
  const saved = readJSON(data("usage.json"));
  const window = object(saved.fiveHour);
  if (!Number.isFinite(window.usedPercentage) || window.usedPercentage < 0 || window.usedPercentage > 100 ||
      !(resetMilliseconds(window.resetsAt) > Date.now())) return null;
  return { left: Number((100 - window.usedPercentage).toFixed(1)), reset: resetMilliseconds(window.resetsAt) };
}
const codexList = (allowed) => Object.entries(allowed).map(([model, list]) => `${model} ${list.join(", ")}`).join(" · ") || "none";
// The orchestrator's per-message context; it carries Invoke status so the orchestrator never runs invoke-status.
async function promptLine(state, soft) {
  const mode = state.mode.value, window = usage();
  const parts = [`Router: mode=${mode}`];
  if (mode === "mixed") parts.push(`Use first: ${state.prefer}`);
  parts.push(`Claude 5h: ${window ? `${window.left}% left` : "unknown"}${window && window.left <= 30 ? " · LOW: no Claude workers" : ""}`, `Claude workers: ${allowedList()}`);
  if (mode !== "claude" || state.review.value === "on") {
    const status = await invokeStatus();
    parts.push(`Invoke: ${invokeState(status)}`);
    if (invokeState(status) === "on") parts.push(`Codex: ${codexList(codexAllowedFrom(status))}`);
  }
  if (["mixed", "codex"].includes(mode)) parts.push(`Speed: ${state.codexSpeed.mode}`);
  parts.push(`Codex review in claude mode: ${state.review.value}`);
  if (soft) parts.push(soft);
  return parts.join(" · ");
}
export function matchesScope(file, pattern) {
  const glob = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let expression = "^";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") { expression += ".*"; i++; }
    else if (glob[i] === "*") expression += "[^/]*";
    else if (glob[i] === "?") expression += "[^/]";
    else expression += glob[i].replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(file.replace(/\\/g, "/"));
}
const scopes = (text) => String(text || "").split(",").map((part) => part.trim()).filter(Boolean);
function git(cwd, args, options = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
}
function gitText(cwd, args, options) {
  const result = git(cwd, args, options);
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || "Git command failed").trim());
  return result.stdout.includes("\0") ? result.stdout : result.stdout.trim();
}
function layout(cwd) {
  const root = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const common = path.resolve(root, gitText(root, ["rev-parse", "--git-common-dir"]));
  return { root, common };
}
function worktrees(root) {
  return gitText(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter(Boolean).map((record) => {
    const lines = record.split("\0");
    return { root: lines.find((line) => line.startsWith("worktree "))?.slice(9),
      branch: lines.find((line) => line.startsWith("branch "))?.slice(7), locked: lines.some((line) => line.startsWith("locked")) };
  });
}
function mainWorktree(cwd) {
  const current = layout(cwd);
  const entries = worktrees(current.root);
  const entry = entries.find((item) => comparable(item.root) === comparable(current.root));
  return { ...current, main: entries[0]?.root, registered: !!entry, entry, entries };
}
function walkDirectories(root, visit, depth = 1) {
  if (depth > 3) return;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory() || [".git", "target"].includes(item.name)) continue;
    const full = path.join(root, item.name);
    if (item.name === "node_modules") visit(full);
    else walkDirectories(full, visit, depth + 1);
  }
}
// Claude Code copies untracked .claude/settings.local.json into worker worktrees; identical copies are not worker changes.
function identicalCopy(main, worker, file) {
  if (!main || comparable(main) === comparable(worker)) return false;
  try { return fs.readFileSync(path.join(main, file)).equals(fs.readFileSync(path.join(worker, file))); }
  catch { return false; }
}
const baseRefWarning = `Router warning: set "worktree": { "baseRef": "head" } in .claude/settings.local.json so workers start from your current branch.`;
function worktreeBaseRef(directory) {
  return [path.join(home, ".claude", "settings.json"), path.join(directory, ".claude", "settings.json"), path.join(directory, ".claude", "settings.local.json")]
    .reduce((ref, file) => object(readJSON(file)).worktree?.baseRef ?? ref, undefined);
}
function isRepository(directory) {
  try { layout(directory); return true; }
  catch { return false; }
}
function sharedDependencies(cwd, projectDir) {
  const current = mainWorktree(cwd);
  if (projectDir) {
    // A session folder outside any repository is ignored; the worker's own repository is used.
    try {
      const parent = layout(projectDir);
      if (comparable(parent.common) === comparable(current.common)) current.main = parent.root;
    } catch {}
  }
  if (!current.registered || comparable(current.root) === comparable(current.main)) return;
  function link(source) {
    const relative = path.relative(current.main, source);
    if (git(current.main, ["check-ignore", "-q", "--", relative]).status !== 0) return;
    const destination = path.join(current.root, relative);
    if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false })) return;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
  }
  walkDirectories(current.main, link);
  const cargo = [];
  function findCargo(directory, depth = 1) {
    if (depth > 3) return;
    if (fs.existsSync(path.join(directory, "Cargo.toml")) && fs.statSync(path.join(directory, "target"), { throwIfNoEntry: false })?.isDirectory()) cargo.push(path.join(directory, "target"));
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory() && ![".git", "node_modules", "target"].includes(item.name)) findCargo(path.join(directory, item.name), depth + 1);
    }
  }
  findCargo(current.main);
  // Hooks cannot export CARGO_TARGET_DIR into the worker. An ignored junction
  // exposes the same single Cargo cache the invoker uses via its environment.
  if (cargo.length === 1) link(cargo[0]);
}
function canonical(file) {
  let existing = file;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...tail);
}
function relativeEdit(cwd, file) {
  const root = layout(cwd).root;
  const absolute = path.resolve(cwd, String(file).replace(/\\/g, path.sep));
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  const realRelative = path.relative(canonical(root), canonical(absolute));
  const outside = (value) => value === ".." || value.startsWith(`..${path.sep}`) || value.startsWith("../") || path.isAbsolute(value);
  return { root, relative, safe: !outside(relative) && !outside(realRelative) && relative !== ".git" && !relative.startsWith(".git/") };
}
const context = (event, text) => text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
const decision = (value, reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: value, permissionDecisionReason: reason } });
const isWorker = (type) => workerNames.some((name) => type === `${pluginName}:${name}`);

// Session size, soft limit (80%), hard limit and handoff. The released router leaves all of it to router-dev in a Dev test session.
const kilo = (n) => `${Math.round(n / 1000)}k`;
const resumes = (text) => /(?:^|\s)--resume-thread(?:\s|=|$)/.test(String(text || ""));
const devSession = (id) => {
  const safe = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return pluginName === "router" && !!safe && fs.existsSync(path.join(home, ".gswitchtool-dev", "dev-sessions", safe));
};
// Input tokens of the newest main-thread assistant line, read from the end of the transcript in chunks.
function transcriptSize(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    let position = fs.fstatSync(fd).size, tail = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(262144, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      tail = Buffer.concat([chunk, tail]);
      // Lines before the first newline may be cut off; they are completed by the next chunk.
      const start = position > 0 ? tail.indexOf(10) + 1 : 0;
      if (position > 0 && start === 0) continue;
      const lines = tail.subarray(start).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue;
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const usage = object(entry?.message?.usage);
        if (entry?.type !== "assistant" || entry.isSidechain === true || entry.message?.model === "<synthetic>" || !entry.message?.usage) continue;
        return ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].reduce((sum, name) => sum + (Number.isFinite(usage[name]) ? usage[name] : 0), 0);
      }
      tail = tail.subarray(0, start);
    }
  } catch { return null; }
  finally { fs.closeSync(fd); }
  return null;
}
// Input tokens of the FIRST main-thread assistant line, read from the start of the transcript in chunks.
function transcriptStartSize(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const total = fs.fstatSync(fd).size;
    let position = 0, rest = Buffer.alloc(0);
    while (position < total) {
      const length = Math.min(262144, total - position);
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      position += length;
      rest = Buffer.concat([rest, chunk]);
      const end = position < total ? rest.lastIndexOf(10) : rest.length;
      if (end < 0) continue;
      const lines = rest.subarray(0, end).toString("utf8").split("\n");
      rest = rest.subarray(end);
      for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const usage = object(entry?.message?.usage);
        if (entry?.type !== "assistant" || entry.isSidechain === true || entry.message?.model === "<synthetic>" || !entry.message?.usage) continue;
        return ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].reduce((sum, name) => sum + (Number.isFinite(usage[name]) ? usage[name] : 0), 0);
      }
    }
  } catch { return null; }
  finally { fs.closeSync(fd); }
  return null;
}
// A subagent's hook call measures the main transcript the session file remembers.
// A session that already starts at 80% of the limit (a fresh one is about 60k) is not limited; the owner is told to raise the limit.
function sizing(input, sess) {
  const limit = config().sessionLimit;
  const file = input.agent_id ? sess.transcriptPath : input.transcript_path;
  const hasFile = typeof file === "string" && file;
  const known = [hasFile ? transcriptSize(file) : null, sess.fullSize].filter(Number.isFinite);
  const size = known.length ? Math.max(...known) : null;
  // Read each time, never cached: sizing also runs outside the state lock, where a session write could lose worker bindings.
  const startSize = hasFile ? transcriptStartSize(file) : null;
  const guard = sess.full !== true && startSize !== null && startSize >= Math.floor(limit * 0.8);
  const full = sess.full === true || (!guard && size !== null && size >= limit);
  const of = `${kilo(size ?? limit)} of ${kilo(limit)}`;
  return { size, limit, full, guard, guardLine: `Session limit ${kilo(limit)} is below this session's starting size (${kilo(startSize ?? 0)}): raise it in GSwitch → Claude Code`,
    of, soft: full || (!guard && size !== null && size >= Math.floor(limit * 0.8)), line: `Session ${of}: finish current tasks, start no new ones` };
}
const savedText = (info) => `This session is full (${info.of}). The handoff is saved. Open a new session in this folder and type continue.`;
const handoffFile = (id) => data("handoffs", `${safeName(id)}.json`);
const readHandoff = (id) => { const value = readJSON(handoffFile(id), null); return value?.version === 1 ? value : null; };
const sessionProject = (input) => projectKey(process.env.CLAUDE_PROJECT_DIR || input.cwd);
// The router's own view of the work in flight, each part on its own so one failure shows as unknown.
function handoffFacts(id, project, sess) {
  const part = (action) => { try { return action(); } catch { return "unknown"; } };
  const list = (items) => items.length ? items.join("; ") : "none";
  let open = [];
  const openTasks = part(() => {
    const records = readResults(data("results.jsonl")).filter((r) => r.sessionId === id);
    open = [...new Set(records.filter((r) => r.type === "plan").map((r) => r.task))].map((task) => taskState(records, id, task)).filter((state) => !state.done);
    return list(open.map(({ plan, last }) => `${plan.task} ${plan.title ? `"${plan.title}" ` : ""}(${plan.kind}, ${plan.difficulty})${last ? `, last: ${last.worker} ${last.outcome}${last.reason ? ` (${last.reason})` : ""}` : ""}`));
  });
  const codexJobs = () => {
    const root = path.join(pluginsHome, "data"), jobs = [];
    if (!fs.existsSync(root)) return "none";
    for (const name of fs.readdirSync(root)) {
      if (pluginName === "router-dev" ? !name.startsWith("codex-dev-") : !name.startsWith("codex-") || name.startsWith("codex-dev-")) continue;
      try {
        for (const sub of fs.readdirSync(path.join(root, name, "state"))) {
          for (const job of readJSON(path.join(root, name, "state", sub, "state.json")).jobs ?? []) {
            if (job?.sessionId !== id || !["queued", "running"].includes(job.status)) continue;
            let gone = false;
            if (job.pid) try { process.kill(job.pid, 0); } catch (error) { gone = error.code !== "EPERM"; }
            jobs.push(`${job.id} thread ${job.threadId ?? "none"} "${shortTitle(job.title) ?? ""}"${gone ? " (process gone)" : ""}`);
          }
        }
      } catch {}
    }
    return list(jobs);
  };
  return { time: new Date().toISOString(),
    branch: part(() => gitText(project, ["rev-parse", "--abbrev-ref", "HEAD"])),
    lastCommit: part(() => gitText(project, ["log", "-1", "--format=%h %s"])),
    uncommitted: part(() => {
      const status = git(project, ["status", "--porcelain"]);
      if (status.status !== 0) throw new Error("git status failed");
      const files = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
      return files.length ? `${files.length} file${files.length === 1 ? "" : "s"}: ${files.slice(0, 20).join(", ")}${files.length > 20 ? `, and ${files.length - 20} more` : ""}` : "none";
    }),
    openTasks,
    codexThreads: part(() => [...new Set(open.flatMap((state) => state.results.map((r) => r.codexThreadId).filter(Boolean)))].join("; ")),
    workers: part(() => list(Object.entries(sess.bindings).filter(([agent, bound]) => {
      const stopped = sess.finished.find((worker) => worker.agentId === agent);
      return !stopped || (bound.resumedAt != null && bound.resumedAt > stopped.time);
    }).map(([agent, bound]) => `${agent} ${bound.type} ${bound.task ?? "-"}`))),
    codexJobs: part(codexJobs),
    worktrees: part(() => list(worktrees(project).slice(1).map((item) => `${item.root} (${[item.branch?.replace(/^refs\/heads\//, "") ?? "detached", item.locked && "locked"].filter(Boolean).join(", ")})`))) };
}
function newHandoff(id, input, sess, info, judgement = null) {
  const project = sessionProject(input);
  return { version: 1, sessionId: id, project, createdAt: new Date().toISOString(), size: info.size, limit: info.limit, judgement,
    facts: handoffFacts(id, project, sess), nextRequests: [], usedAt: null, usedBy: null };
}
function handoffText(handoff) {
  const facts = object(handoff.facts), fact = (name) => facts[name] ?? "unknown";
  const lines = [`Handoff from the previous session (ended at ${kilo(handoff.size ?? handoff.limit)} of ${kilo(handoff.limit)}, ${handoff.createdAt}). Start by saying in 3 lines where things stand, then continue.`,
    handoff.judgement || "(No written handoff: the session filled up before writing one.)", `Facts (router, ${fact("time")}):`,
    `- Branch: ${fact("branch")} · last commit ${fact("lastCommit")}`, `- Uncommitted: ${fact("uncommitted")}`, `- Open tasks: ${fact("openTasks")}`,
    `- Claude workers still running: ${fact("workers")}`, `- Codex jobs running: ${fact("codexJobs")}`, `- Kept worktrees: ${fact("worktrees")}`];
  if (facts.codexThreads) lines.push(`- Codex threads of open tasks: ${facts.codexThreads}`);
  for (const request of Array.isArray(handoff.nextRequests) ? handoff.nextRequests : []) lines.push(`Next request (typed in the full session): ${String(request.text).replace(/\s+/g, " ").trim()}`);
  return lines.join("\n");
}
// The newest unused handoff of this folder; older unused ones are superseded. Runs under the state lock.
function takeHandoff(id, project) {
  let found = [];
  try {
    found = fs.readdirSync(data("handoffs")).filter((name) => name.endsWith(".json")).map((name) => ({ file: data("handoffs", name), handoff: readJSON(data("handoffs", name), null) }))
      .filter(({ handoff }) => handoff?.version === 1 && handoff.usedAt == null && handoff.sessionId !== id && typeof handoff.project === "string" && comparable(handoff.project) === comparable(project));
  } catch {}
  found.sort((a, b) => String(b.handoff.createdAt).localeCompare(String(a.handoff.createdAt)));
  const now = new Date().toISOString();
  for (const { file, handoff } of found) atomicJSON(file, { ...handoff, usedAt: now, usedBy: id });
  return found[0]?.handoff ?? null;
}
// A prompt typed in a full session is blocked, kept for the next session, and the handoff is saved if it is not yet.
async function fullPrompt(id, input, info) {
  await locked(() => {
    const current = session(id);
    saveSession(id, { ...current, full: true, fullSize: info.size ?? current.fullSize, transcriptPath: input.transcript_path ?? current.transcriptPath });
    const handoff = readHandoff(id) ?? newHandoff(id, input, current, info);
    // Background-task notices also pass UserPromptSubmit; they are blocked but are not the owner's next request.
    const typed = String(input.prompt ?? "").trim();
    const text = /^<(?:task-notification|system-reminder|agent-message)\b/.test(typed) ? "" : typed.slice(0, 2000);
    handoff.nextRequests = Array.isArray(handoff.nextRequests) ? handoff.nextRequests : [];
    if (text) handoff.nextRequests.push({ time: new Date().toISOString(), text });
    if (handoff.usedAt) { handoff.usedAt = null; handoff.usedBy = null; }
    atomicJSON(handoffFile(id), handoff);
  });
  return { decision: "block", reason: savedText(info) };
}
// Stop in a full session: the first one asks for the handoff, the next one saves the reply. Never blocks twice.
async function stop(input) {
  const id = input.session_id;
  if (input.agent_id || !id || devSession(id)) return {};
  const info = sizing(input, session(id));
  if (!info.full) return {};
  const existing = readHandoff(id);
  if (existing?.judgement) return {};
  const ask = await locked(() => {
    const current = session(id);
    // Another plugin's Stop block (stop_hook_active) does not count as our request: ask once all the same.
    if (current.handoffRequested === true) return false;
    saveSession(id, { ...current, full: true, fullSize: info.size ?? current.fullSize, handoffRequested: true, transcriptPath: input.transcript_path ?? current.transcriptPath });
    return true;
  });
  if (ask) return { decision: "block", reason: `This session is full (${info.of}). Write the handoff now. Reply with only the handoff, at most 60 lines, for the next session: the goal, decisions made and why, the current state (done, in progress), the exact next step, and anything the next session would get wrong. Do not run tools and do not start new work. The router adds the facts itself: open tasks, running Codex jobs and threads, kept worktrees, branch, last commit, uncommitted files.` };
  const reply = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message : transcriptText(input.transcript_path);
  const judgement = reply.trim().split(/\r?\n/).slice(0, 60).join("\n").trim() || null;
  await locked(() => atomicJSON(handoffFile(id), { ...newHandoff(id, input, session(id), info, judgement),
    nextRequests: Array.isArray(existing?.nextRequests) ? existing.nextRequests : [] }));
  return { systemMessage: savedText(info) };
}
// Protected: the router's data, the app's setup file and the installed plugin copies change only through GSwitch and the router.
const protectedReason = "Protected: the router's settings, session and handoff files and the installed plugin change only through GSwitch and the router. Change settings in GSwitch → Claude Code.";
const slashes = (text) => String(text ?? "").replace(/\\/g, "/");
const foldCase = (text) => process.platform === "win32" ? text.toLowerCase() : text;
const pluginsHome = path.join(home, ".claude", "plugins");
const within = (file, root) => {
  const a = foldCase(slashes(file)).replace(/\/+$/, ""), b = foldCase(slashes(root)).replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
};
function protectedEdit(input) {
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (typeof file !== "string" || !file) return false;
  const absolute = path.resolve(input.cwd || process.cwd(), file);
  const roots = [dataDir, setupFile, path.join(pluginsHome, "cache"), path.join(pluginsHome, "marketplaces"), ...(within(pluginRoot, pluginsHome) ? [pluginRoot] : [])];
  // Compare as written and with symlinks and short names resolved.
  const real = (list) => [...list, ...list.flatMap((item) => { try { return [canonical(item)]; } catch { return []; } })];
  const protectedRoots = real(roots);
  return real([absolute]).some((target) => protectedRoots.some((root) => within(target, root)));
}
function protectedCommand(command) {
  const homePath = slashes(home);
  // The scripts the skills run themselves (router.mjs, codex-companion.mjs) may live in the installed plugin.
  const text = slashes(command).replace(/(^|[\s"'=:(])~(?=\/|\s|"|'|$)/g, (_, before) => before + homePath)
    .replace(/\$\{?(?:HOME|USERPROFILE)\}?|\$env:USERPROFILE|%USERPROFILE%/gi, () => homePath)
    .replace(/(^|[\s;&|(])node(?:\.exe)?["']?\s+(?:"[^"]*|'[^']*|[^\s"']*)\/(?:scripts\/router|codex-companion)\.mjs["']?/gi, "$1node");
  const hay = foldCase(text);
  return [dataName, "claude-setup.json", ".claude/plugins/cache", ".claude/plugins/marketplaces", ...(within(pluginRoot, pluginsHome) ? [slashes(pluginRoot)] : [])]
    .some((fragment) => hay.includes(foldCase(fragment)));
}
function protection(input) {
  const tool = input.tool_name;
  const hit = ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool) ? () => protectedEdit(input)
    : ["Bash", "PowerShell"].includes(tool) ? () => protectedCommand(input.tool_input?.command) : null;
  return hit && !devSession(input.session_id) && hit() ? decision("deny", protectedReason) : null;
}
// An inline invoke brief starts right after its opening quote; a prompt file may use CRLF.
const header = (text, name) => String(text || "").match(new RegExp(`(?:^|["'])[ \\t]*${name}:[ \\t]*([\\w.-]{1,40})[ \\t]*["']?[ \\t]*\\r?$`, "m"))?.[1];
const taskId = (text) => header(text, "TASK");
const verifyCommand = (text) => String(text || "").match(/^\s*VERIFY:[ \t]*([^\r\n]+)\r?$/m)?.[1].trim().replace(/^`([^`]+)`$/, "$1") || null;
const shortTitle = (value) => {
  const title = [...String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, 120).join("").trim();
  return title || null;
};
// On the invoke command's line, an inline brief starts after its still-open quote.
const briefStart = (line) => {
  if (!line.includes("codex-companion.mjs")) return line;
  const open = ['"', "'"].find((quote) => line.split(quote).length % 2 === 0);
  return open ? line.slice(line.lastIndexOf(open) + 1) : "";
};
// The first brief line that is not a header.
const briefTitle = (text) => shortTitle(String(text || "").split(/\r?\n/).map((line) => briefStart(line).trim().replace(/^["']|["']$/g, "").trim())
  .find((line) => line && !/^[A-Z][A-Z ]*:/.test(line)));
const failedList = (state) => state.results.filter((r) => r.outcome === "fail").map((r) => `${r.worker} (${r.reason ?? "other"})`).join(", ");
const floorFor = (state) => {
  const failed = state.failedWorkers.filter(({ sample }) => !sample);
  return taskFloor(state.plan.kind, state.plan.difficulty,
    failed.map(({ worker }) => benchmarks[benchmarkId(worker)]?.score), failed.length);
};
// The brief's KIND/DIFFICULTY lines record the plan; the launch that creates it may redirect to a sample worker once.
async function taskLaunch({ id, project, task, type, title, brief, repair = false }) {
  const file = data("results.jsonl");
  let state = taskState(readResults(file), id, task);
  const kind = header(brief, "KIND"), difficulty = header(brief, "DIFFICULTY");
  if (!state.plan && (!kind || !difficulty)) {
    const missing = [!kind && "KIND: <kind>", !difficulty && "DIFFICULTY: <difficulty>"].filter(Boolean);
    return decision("deny", `Add ${missing.join(" and ")} line${missing.length > 1 ? "s" : ""} to the brief.`);
  }
  if (kind && !kinds.includes(kind)) return decision("deny", `KIND must be one of: ${kinds.join(", ")}.`);
  if (difficulty && !difficulties.includes(difficulty)) return decision("deny", `DIFFICULTY must be one of: ${difficulties.join(", ")}.`);
  const created = !state.plan;
  if (kind && difficulty && (created || state.plan.kind !== kind || state.plan.difficulty !== difficulty)) {
    const record = { type: "plan", time: new Date().toISOString(), sessionId: id, project, task, kind, difficulty, title: shortTitle(title),
      codex: null, files: null, crossModule: null, check: null, repro: null, confidence: null, sample: null, source: "brief" };
    const cfg = config();
    // A re-plan keeps the first plan's sample decision, so only a new plan needs the worker rows.
    const rows = created ? workerTable({ claudeAllowed: cfg.claudeAllowed, codexAllowed: codexAllowedFrom(await invokeStatus()),
      mode: cfg.mode, low: usage()?.left <= 30, namespace: pluginName }) : [];
    record.sample = sampleWorker(readResults(file), record, rows, { sampling: cfg.sampling, prefer: cfg.prefer, roll: sampleRoll() });
    appendResult(file, record);
    state = taskState(readResults(file), id, task);
    if (created && record.sample && record.sample !== type) return decision("deny", `Sample attempt for task ${task}: launch ${record.sample} instead (about 1 in 10 trivial/small tasks); say sample attempt in your report.`);
  }
  if (state.done) return decision("deny", `Task ${task} already passed; use a new task id for new work.`);
  const failed = state.failedWorkers.find(({ worker }) => worker === type);
  if (failed && !repair) return decision("deny", `${type} already failed task ${task} (${failed.reasons.join(", ")}); resume that worker for a repair or pick a candidate from router plan.`);
  const reasons = [], score = benchmarks[benchmarkId(type)]?.score, { floor } = floorFor(state);
  // A repair resumes the worker that failed, so the raised floor does not apply to it.
  if (!repair && score != null && score < floor) reasons.push(`${type} scores ${score}, below floor ${floor} for task ${task}`);
  if (state.failures >= ownerCheckAfter) reasons.push(`Task ${task} has ${state.failures} failed attempts (${failedList(state)}); continue with ${type}?`);
  if (needsApproval(benchmarkId(type))) reasons.push(`Approve ${type} for task: ${state.plan.title || title}`);
  return reasons.length ? decision("ask", reasons.join(" · ")) : {};
}
// Read simple invoke flags (`--name value` or `--name=value`); like the companion's parser, the last one wins.
function shellOption(command, names) {
  const matches = [...command.matchAll(new RegExp(`(?:^|\\s)(?:${names.join("|")})(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|([^\\s"']+))`, "g"))];
  const match = matches.at(-1);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}
// invoke-run (the codex-runner agent's launch) is an invoke; invoke-wait only waits for one.
const invokePath = (command) => command.match(/(?:^|[\n;|(]|&&|\|\|)[ \t]*node(?:\.exe)?["']?\s+((?:"[^"]*|'[^']*|[^\s"']*)codex-companion\.mjs)["']?\s+invoke(?:-run)?(?:\s|$)/)?.[1];
const isInvoke = (command) => {
  const companion = invokePath(command);
  return companion !== undefined && /(?:^|["'\\/])codex-dev[\\/]/.test(companion) === (pluginName === "router-dev");
};
// The brief of an invoke: the inline text and, with --prompt-file, the file's text.
function invokeBrief(command, cwd) {
  let task = taskId(command), text = command;
  const file = shellOption(command, ["--prompt-file"]);
  if (file) {
    const directory = shellOption(command, ["--cwd"]);
    try { text = fs.readFileSync(path.resolve(directory ? path.resolve(cwd, directory) : cwd, file), "utf8"); task = task ?? taskId(text); }
    catch { if (!task) return undefined; }
  }
  return task ? { task, text: text === command ? text : `${command}\n${text}`, title: briefTitle(text) } : undefined;
}
const invokeTask = (command, cwd) => invokeBrief(command, cwd)?.task;
const codexWorker = (command) => {
  const model = shellOption(command, ["--model", "-m"]), effort = shellOption(command, ["--effort"]);
  return model && effort ? `${pluginName === "router-dev" ? "codex-dev" : "codex"}:${model}/${effort}` : null;
};
function codexLaunch(input) {
  const command = String(input.tool_input?.command || "");
  if (!isInvoke(command)) return null;
  const task = invokeTask(command, input.cwd || process.cwd());
  if (!task || config().mode === "off") return null;
  const worker = codexWorker(command);
  return worker ? { task, worker, time: Date.now() } : null;
}
async function hook(event, input) {
  const command = String(input.tool_input?.command || "");
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) && input.tool_name === "Bash" && !isInvoke(command)) return {};
  // Runs outside the state lock: it takes the lock itself only to read and write state.
  if (event === "SubagentStop") return subagentStop(input);
  if (event === "Stop") return stop(input);
  // Expire old worker state, including a resumed session with this ID, and handoffs after 30 days.
  if (event === "SessionStart") for (const [folder, days] of [["sessions", 7], ["handoffs", 30]]) if (fs.existsSync(data(folder))) for (const name of fs.readdirSync(data(folder))) {
    const file = data(folder, name);
    if (name.endsWith(".json") && fs.statSync(file).mtimeMs < Date.now() - days * 86400000) fs.rmSync(file);
  }
  const id = input.session_id;
  const cwd = input.cwd || process.cwd();
  const sess = session(id);
  const state = resolved();
  const dev = devSession(id);
  // Subagent hook calls measure the main transcript, so the main thread's path is kept (UserPromptSubmit runs unlocked and does it below).
  if (id && event !== "UserPromptSubmit" && !input.agent_id && typeof input.transcript_path === "string" && input.transcript_path && sess.transcriptPath !== input.transcript_path) {
    sess.transcriptPath = input.transcript_path; saveSession(id, sess);
  }
  if (["PostToolUse", "PostToolUseFailure"].includes(event) && input.tool_name === "Bash") {
    const launch = codexLaunch(input);
    if (launch) { sess.codexLaunches.push(launch); saveSession(id, sess); }
    return {};
  }
  // Observe completions even when the owner turned routing off mid-attempt.
  if (event === "PostToolUse" && ["Agent", "Task"].includes(input.tool_name) && isWorker(input.tool_input?.subagent_type)) {
    const response = object(input.tool_response);
    // A background launch receipt has no work yet; SubagentStop records the finished attempt.
    if (response.isAsync === true) return {};
    // input.agent_id identifies the caller, not the Agent tool's child.
    const agentId = [response.agentId, response.agent_id].find((value) => typeof value === "string" && value) || null;
    const worker = input.tool_input.subagent_type;
    const bound = agentId ? sess.bindings[agentId] : undefined;
    appendResult(data("results.jsonl"), attemptRecord(input, { sessionId: id, project: projectKey(sess.projectDir || cwd), agentId, worker, task: bound?.task ?? taskId(input.tool_input.prompt) ?? null,
      scope: bound?.type === worker && Array.isArray(bound.scope) ? bound.scope : scopes(String(input.tool_input.prompt || "").match(/^\s*SCOPE:[ \t]*([^\r\n]+)$/m)?.[1]) }));
    return {};
  }
  if (event === "SessionStart") {
    const lines = state.mode.value === "off" ? [] : [routerLine(state)];
    if (state.mode.value !== "off" && worktreeBaseRef(cwd) !== "head") lines.push(baseRefWarning);
    const model = typeof input.model === "string" ? input.model : input.model?.id;
    if (state.mode.value !== "off" && model && !/opus/i.test(model)) lines.push("Router warning: use an Opus model for the orchestrator.");
    if (!dev) {
      const info = sizing(input, sess);
      if (info.full) lines.push(`This session is full (${info.of}); new messages are blocked. Open a new session in this folder and type continue.`);
      else if (["startup", "clear"].includes(input.source)) {
        const handoff = takeHandoff(id, sessionProject(input));
        if (handoff) lines.push(handoffText(handoff));
      }
    }
    return context(event, lines.join("\n"));
  }
  if (event === "UserPromptSubmit") {
    let soft = "";
    if (!dev) {
      const info = sizing(input, sess);
      if (info.full) return fullPrompt(id, input, info);
      if (info.soft) soft = info.line;
      else if (info.guard) soft = info.guardLine;
      // The main thread's path is kept under the lock only when it changes.
      if (id && typeof input.transcript_path === "string" && input.transcript_path && sess.transcriptPath !== input.transcript_path)
        await locked(() => saveSession(id, { ...session(id), transcriptPath: input.transcript_path }));
    }
    if (state.mode.value === "off") return context(event, soft);
    return context(event, await promptLine(state, soft));
  }
  if (event === "PreCompact") {
    if (dev) return {};
    const info = sizing(input, sess);
    if (input.trigger === "auto" && !info.guard) saveSession(id, { ...sess, full: true, fullSize: info.size ?? sess.fullSize });
    return { decision: "block", reason: `Compaction is off: this session hands off at ${kilo(info.limit)} instead (now ${info.size === null ? "unknown" : kilo(info.size)}).` };
  }
  if (event === "PreToolUse" && input.tool_name === "SendMessage") {
    const bound = sess.bindings[input.tool_input?.to];
    if (!bound) return {};
    bound.resumedAt = Date.now();
    // A resumed worker is checked again when it next stops.
    delete bound.appliedAt; delete bound.verdictPending;
    saveSession(id, sess);
    if (state.mode.value === "off" || !bound.task) return {};
    const task = taskState(readResults(data("results.jsonl")), id, bound.task);
    return task.failures >= ownerCheckAfter && !task.done
      ? decision("ask", `Task ${bound.task} has ${task.failures} failed attempts; continue by resuming ${bound.type}?`) : {};
  }
  // Past 80% of the session limit nothing new starts, in every mode; running workers and Codex threads may be resumed.
  if (event === "PreToolUse" && !dev) {
    const type = input.tool_input?.subagent_type;
    const launch = ["Agent", "Task"].includes(input.tool_name) ? isWorker(type) || (/^codex(?:-dev)?:codex-runner$/.test(type) && !resumes(input.tool_input?.prompt)) : input.tool_name === "Bash" && !resumes(command);
    if (launch) {
      const info = sizing(input, sess);
      if (info.soft) return decision("deny", `Session ${info.of}: finish current tasks, start no new ones. Resume a running worker with SendMessage or a Codex thread with --resume-thread.`);
    }
  }
  if (state.mode.value === "off") return {};
  if (event === "PreToolUse" && input.tool_name === "Bash") {
    if (sess.bindings[input.agent_id]) return decision("deny", "Router workers cannot start other agents.");
    const brief = invokeBrief(command, cwd);
    if (!brief) return {};
    if (state.mode.value === "claude" && /(?:^|\s)--write(?:\s|$)/.test(command)) return decision("deny", "Claude mode: Codex does not write code; use a Claude worker.");
    const type = codexWorker(command);
    if (!type) return {};
    return taskLaunch({ id, project: projectKey(sess.projectDir || cwd), task: brief.task, type, title: brief.title, brief: brief.text,
      repair: /(?:^|\s)--resume-thread(?:\s|$)/.test(command) });
  }
  if (event === "PreToolUse" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(input.tool_name)) {
    const bound = sess.bindings[input.agent_id];
    if (!bound) return isWorker(input.agent_type) ? decision("deny", "Router has no scope for this worker; stop and report.") : {};
    if (bound.verdictPending) return decision("deny", "The router already checked your work; do not edit. Reply with your report and the ROUTER lines.");
    // Claude Code deletes an unchanged worker's worktree; a resume then runs in the main checkout.
    if (bound.cwd && !fs.existsSync(bound.cwd)) return decision("deny", `WORKTREE GONE: ${bound.cwd} no longer exists, so this edit would land in the main checkout. Do not edit; stop and tell the orchestrator to start a new worker.`);
    const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
    if (!file) return decision("deny", "OUT OF SCOPE: missing file path. Stop and return a SCOPE REQUEST.");
    const edit = relativeEdit(bound.cwd || cwd, file);
    if (edit.safe && (bound.scope.some((pattern) => matchesScope(edit.relative, pattern)) || git(edit.root, ["check-ignore", "-q", "--", edit.relative]).status === 0)) return {};
    return decision("deny", `OUT OF SCOPE: ${edit.relative}. Do not edit it and do not work around this block. Stop and end your answer with: SCOPE REQUEST: ${edit.relative} — <why> — <intended change>`);
  }
  if (event === "PreToolUse" && ["Agent", "Task"].includes(input.tool_name)) {
    const tool = object(input.tool_input);
    const type = tool.subagent_type;
    // A router worker may never launch another worker, including helpers.
    if (sess.bindings[input.agent_id]) return decision("deny", "Router workers cannot start other agents.");
    if (["Explore", "Plan"].includes(type)) return {};
    if (workerNames.some((name) => type === `${pluginName === "router-dev" ? "router" : "router-dev"}:${name}`)) return {};
    // The Codex plugin's runner starts invoke-run, which the Bash gate checks; claude mode still denies --write there.
    if (type === "codex:codex-runner" || type === "codex-dev:codex-runner") return {};
    if (!isWorker(type)) return decision("deny", "use a router worker type");
    if (tool.model !== undefined) return decision("deny", "Router worker model is fixed; remove the model override.");
    if (state.mode.value === "codex") return decision("deny", "Codex mode denies Claude workers; send this to Codex.");
    const name = type.slice(pluginName.length + 1);
    const [model, effort] = name.split("-");
    const allowed = config().claudeAllowed;
    if (!allowed[model]?.includes(effort)) return decision("deny", `${type} is not allowed. Allowed: ${allowedList(allowed)}. Pick an allowed worker or send the task to Codex.`);
    if (usage()?.left <= 30) return decision("deny", state.mode.value === "mixed" ? "LOW usage: send this to Codex" : "LOW usage: stop and wrap up, ask the owner");
    const scope = scopes(String(tool.prompt || "").match(/^\s*SCOPE:[ \t]*([^\r\n]+)$/m)?.[1]);
    if (!scope.length) return decision("deny", "Add a line SCOPE: <globs> to the worker prompt (comma-separated paths).");
    const task = taskId(tool.prompt);
    if (!task) return decision("deny", "Add a line TASK: <id> to the worker prompt.");
    const permission = await taskLaunch({ id, project: projectKey(sess.projectDir || cwd), task, type,
      title: typeof tool.description === "string" && tool.description.trim() ? tool.description : briefTitle(tool.prompt), brief: tool.prompt });
    if (permission.hookSpecificOutput?.permissionDecision === "deny") return permission;
    // Record ask launches too: SubagentStart happens only after approval.
    sess.projectDir = sess.projectDir || projectKey(cwd);
    sess.pending.push({ type, scope, task, verify: verifyCommand(tool.prompt), time: Date.now() });
    saveSession(id, sess);
    return permission;
  }
  if (event === "SubagentStart" && isWorker(input.agent_type) && input.agent_id) {
    const pending = sess.pending.map((launch, index) => ({ launch, index })).filter(({ launch }) => launch.type === input.agent_type).sort((a, b) => a.launch.time - b.launch.time)[0];
    if (pending) {
      sess.pending.splice(pending.index, 1);
      sess.bindings[input.agent_id] = { type: input.agent_type, scope: pending.launch.scope, task: pending.launch.task ?? null,
        verify: pending.launch.verify ?? null, cwd, time: Date.now() };
      saveSession(id, sess);
    }
    if (input.cwd) sharedDependencies(cwd, sess.projectDir);
  }
  return {};
}

function option(args, name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
function check(args) { return checkFacts(args).output; }
function checkFacts(args) {
  const cwd = option(args, "--cwd");
  if (!cwd) throw new Error("check requires --cwd");
  const verify = option(args, "--verify");
  const lines = [], factsResult = { files: 0, added: 0, deleted: 0, verify: "none", scopeWarnings: 0, verifyText: "none", verifyTail: [], outside: [] };
  if (verify) {
    const started = Date.now();
    const result = spawnSync(verify, { cwd, shell: true, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    factsResult.verify = result.status === 0 ? "passed" : "failed";
    factsResult.verifyText = result.status === 0 ? `passed (${verify}, ${Math.round((Date.now() - started) / 1000)}s)` : `FAILED (exit ${result.status ?? 127})`;
    lines.push(`Verify: ${factsResult.verifyText}`);
    if (result.status !== 0) {
      factsResult.verifyTail = `${result.stdout || ""}${result.stderr || ""}${result.error?.message || ""}`.trimEnd().split(/\r?\n/).slice(-40);
      lines.push(...factsResult.verifyTail);
    }
  }
  let root;
  try { root = layout(cwd).root; } catch { return { ...factsResult, output: [...lines, "git: not a repository"].join("\n") }; }
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const base = option(args, "--base") ?? (head.status === 0 ? "HEAD" : gitText(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }));
  const facts = gitText(root, ["diff", "--numstat", "-z", "--no-renames", base]).split("\0").filter(Boolean).map((line) => {
    const [added, deleted, ...name] = line.split("\t");
    return { path: name.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0 };
  });
  const main = mainWorktree(root).main;
  for (const file of gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    if (identicalCopy(main, root, file)) continue;
    const buffer = fs.readFileSync(path.join(root, file));
    const text = buffer.toString("utf8");
    facts.push({ path: file, added: buffer.includes(0) || !text ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0), deleted: 0 });
  }
  facts.sort((a, b) => a.path.localeCompare(b.path));
  const scope = scopes(option(args, "--scope"));
  const outside = scope.length ? facts.filter((file) => !scope.some((pattern) => matchesScope(file.path, pattern))).map((file) => file.path) : [];
  for (const file of outside) lines.push(`WARNING: changed outside --scope: ${file}`);
  const shown = facts.slice(0, 20).map((file) => `${file.path} (+${file.added} −${file.deleted})`).join(", ") || "none";
  lines.push(`Changed files (git): ${shown}${facts.length > 20 ? `, and ${facts.length - 20} more` : ""}; ${facts.length} files, +${facts.reduce((sum, file) => sum + file.added, 0)} −${facts.reduce((sum, file) => sum + file.deleted, 0)}`);
  return { ...factsResult, files: facts.length, added: facts.reduce((sum, file) => sum + file.added, 0),
    deleted: facts.reduce((sum, file) => sum + file.deleted, 0), scopeWarnings: outside.length, outside, output: lines.join("\n") };
}
function apply(args) {
  const worktree = option(args, "--worktree");
  const cwd = option(args, "--cwd");
  let temporary;
  try {
    if (!worktree || !cwd) throw new Error("apply requires --worktree and --cwd");
    const main = mainWorktree(cwd);
    const worker = mainWorktree(worktree);
    const entry = main.entries.find((item) => comparable(item.root) === comparable(worker.root));
    if (comparable(worker.root) !== comparable(worktree) || !entry || comparable(main.common) !== comparable(worker.common) || comparable(main.root) === comparable(worker.root) || comparable(worker.root) === comparable(main.entries[0].root)) throw new Error("not a separate registered worktree of the same repository");
    if (entry.locked && !args.includes("--keep-locked")) throw new Error("worktree is locked");
    if (git(worker.root, ["ls-files", "--unmerged"]).stdout.trim()) throw new Error("worker has unresolved conflicts");
    const base = gitText(main.root, ["merge-base", "HEAD", gitText(worker.root, ["rev-parse", "HEAD"])]);
    fs.mkdirSync(dataDir, { recursive: true });
    temporary = fs.mkdtempSync(data("apply-"));
    const workerEnv = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "worker-index") };
    const mainEnv = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "main-index") };
    gitText(worker.root, ["read-tree", "HEAD"], { env: workerEnv });
    gitText(worker.root, ["add", "-A"], { env: workerEnv });
    const copies = gitText(worker.root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((file) => file && identicalCopy(main.root, worker.root, file));
    if (copies.length) gitText(worker.root, ["rm", "--cached", "-q", "--", ...copies], { env: workerEnv });
    const changed = gitText(worker.root, ["diff", "--cached", "--name-only", "--no-renames", "-z", base], { env: workerEnv }).split("\0").filter(Boolean);
    const patch = git(worker.root, ["diff", "--cached", "--binary", "--no-renames", "--full-index", base], { env: workerEnv, encoding: null });
    if (patch.status !== 0) throw new Error("could not capture worker changes");
    const tracked = new Set(gitText(main.root, ["ls-files", "-z"]).split("\0"));
    for (const file of changed) {
      // Never write through directory symlinks, or overwrite untracked files.
      const edit = relativeEdit(main.root, file);
      if (!edit.safe || comparable(canonical(path.join(main.root, file))) !== comparable(path.join(main.root, file))) throw new Error(`unsafe destination: ${file}`);
      if (!tracked.has(file) && fs.lstatSync(path.join(main.root, file), { throwIfNoEntry: false })) throw new Error(`untracked destination exists: ${file}`);
    }
    const mainIndex = path.resolve(main.root, gitText(main.root, ["rev-parse", "--git-path", "index"]));
    if (fs.existsSync(mainIndex)) fs.copyFileSync(mainIndex, mainEnv.GIT_INDEX_FILE);
    else gitText(main.root, ["read-tree", "HEAD"], { env: mainEnv });
    gitText(main.root, ["add", "-u"], { env: mainEnv });
    const before = gitText(main.root, ["write-tree"], { env: mainEnv });
    if (patch.stdout.length) {
      const merged = git(main.root, ["apply", "--cached", "--3way", "--whitespace=nowarn"], { env: mainEnv, input: patch.stdout });
      if (merged.status !== 0) throw new Error("three-way apply conflict; main working tree unchanged");
      const after = gitText(main.root, ["write-tree"], { env: mainEnv });
      const output = git(main.root, ["diff", "--binary", "--full-index", before, after], { encoding: null });
      if (output.status !== 0) throw new Error("could not capture merged changes");
      if (output.stdout.length) {
        gitText(main.root, ["apply", "--check", "--whitespace=nowarn"], { input: output.stdout });
        gitText(main.root, ["apply", "--whitespace=nowarn"], { input: output.stdout });
      }
    }
    if (entry.locked) return `Worktree: applied ${changed.length} files\nWorktree kept: ${worktree} — locked by Claude Code; remove it after this session`;
    // Unlink caches before removal; never traverse junctions into the main tree.
    function unlinkCaches(directory, depth = 1) {
      if (depth > 4) return;
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, item.name);
        if (["node_modules", "target"].includes(item.name) && fs.lstatSync(full).isSymbolicLink()) fs.unlinkSync(full);
        else if (item.isDirectory() && item.name !== ".git") unlinkCaches(full, depth + 1);
      }
    }
    try { unlinkCaches(worker.root); }
    catch { return `Worktree: applied ${changed.length} files\nWorktree kept: ${worktree} — dependency-link cleanup failed`; }
    const removed = git(main.root, ["worktree", "remove", "--force", worker.root]);
    if (removed.status !== 0) return `Worktree: applied ${changed.length} files\nWorktree kept: ${worktree} — cleanup failed`;
    if (entry.branch?.startsWith("refs/heads/") && !main.entries.some((item) => comparable(item.root) !== comparable(worker.root) && item.branch === entry.branch)) {
      const deleted = git(main.root, ["branch", "-D", "--", entry.branch.slice(11)]);
      if (deleted.status !== 0) return `Worktree: applied ${changed.length} files\nBranch kept: ${entry.branch.slice(11)} — cleanup failed`;
    }
    return `Worktree: applied ${changed.length} files`;
  } catch (error) { return `Worktree kept: ${worktree || "unknown"} — ${error.message}`; }
  finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function statusline(raw) {
  let input;
  try { input = object(JSON.parse(raw)); } catch { input = {}; }
  const window = input.rate_limits?.five_hour;
  await locked(() => {
    if (window) atomicJSON(data("usage.json"), { fiveHour: { usedPercentage: window.used_percentage, resetsAt: window.resets_at }, updatedAt: new Date().toISOString() });
    if (fs.existsSync(data("usage.json")) && !usage()) fs.rmSync(data("usage.json"), { force: true });
  });
  const command = statuslineConfig().statusLineCommand;
  if (typeof command === "string" && command && !isRouterCommand(command)) {
    const result = spawnSync(command, { shell: true, windowsHide: true, input: raw, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.stdout || "";
  }
  return `${routerLine(resolved())}\n`;
}
// Any router command, including one from an older plugin path (for example after a plugin update).
const isRouterCommand = (command) => typeof command === "string" && /router\.mjs"?\s+statusline\s*$/.test(command);
function statuslineSettings(install) {
  const file = path.join(home, ".claude", "settings.json");
  const exists = fs.existsSync(file);
  const raw = exists ? fs.readFileSync(file, "utf8") : "{}";
  // Do not silently replace corrupt user settings with defaults.
  const settings = object(JSON.parse(raw.replace(/^\uFEFF/, "")));
  const cfg = statuslineConfig();
  const command = `node "${path.join(pluginRoot, "scripts", "router.mjs").replace(/\\/g, "/")}" statusline`;
  const current = settings.statusLine?.command;
  if (install && current === command) return "Router status line already installed";
  if (!install && !isRouterCommand(current)) return "Router status line is not installed; settings unchanged";
  if (exists) {
    fs.mkdirSync(data("backups"), { recursive: true });
    fs.writeFileSync(data("backups", `settings-${Date.now()}-${randomUUID()}.json`), raw, { mode: 0o600 });
  }
  if (install) {
    // A router command is replaced, never saved as the previous status line.
    if (!isRouterCommand(current)) {
      cfg.statusLinePrevious = settings.statusLine ?? null;
      if (typeof current === "string") cfg.statusLineCommand = current;
      else delete cfg.statusLineCommand;
    }
    // Drop a router command that an earlier install saved as the previous status line.
    if (isRouterCommand(cfg.statusLinePrevious?.command)) cfg.statusLinePrevious = null;
    if (isRouterCommand(cfg.statusLineCommand)) delete cfg.statusLineCommand;
    atomicJSON(data("config.json"), cfg);
    settings.statusLine = { type: "command", command };
  } else {
    if (cfg.statusLinePrevious) settings.statusLine = cfg.statusLinePrevious;
    else if (cfg.statusLineCommand) settings.statusLine = { type: "command", command: cfg.statusLineCommand };
    else delete settings.statusLine;
  }
  atomicJSON(file, settings, raw.match(/\r?\n([ \t]+)"/)?.[1] || 2, raw.includes("\r\n") ? "\r\n" : "\n");
  if (!install) {
    delete cfg.statusLinePrevious; delete cfg.statusLineCommand;
    atomicJSON(data("config.json"), cfg);
  }
  return `Router status line ${install ? "installed" : "uninstalled"}`;
}
// --codex "<model>:<effort>[,<effort>...][;<model>:...]" -> { model: [efforts] }
function codexAllowed(text) {
  const allowed = {};
  for (const part of text.split(";")) {
    const [model, list, ...extra] = part.split(":").map((item) => item.trim());
    if (extra.length || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model || "") || !list)
      throw new Error(`Invalid --codex "${text}"; use --codex "<model>:<effort>[,<effort>...][;<model>:...]"`);
    for (const effort of list.split(",").map((item) => item.trim())) {
      if (!efforts.includes(effort)) throw new Error(`Unknown Codex effort "${effort}"; use low, medium, high, xhigh or max`);
      allowed[model] = [...new Set([...(allowed[model] || []), effort])];
    }
  }
  return allowed;
}
function workers(args) {
  const at = args.indexOf("--codex");
  const text = at < 0 ? undefined : args[at + 1];
  const unknown = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (unknown.length) throw new Error(`Unknown router workers option: ${unknown[0]}. Use: router workers [--codex "<model>:<effort>[,<effort>...][;<model>:...]"]`);
  if (at >= 0 && (text === undefined || text.startsWith("--"))) throw new Error(`--codex needs a value: "<model>:<effort>[,<effort>...][;<model>:...]"`);
  const codex = text === undefined ? {} : codexAllowed(text);
  const state = resolved();
  const mode = state.mode.value;
  if (mode === "off") return "Router is off.";
  const low = usage()?.left <= 30;
  const rows = workerTable({ claudeAllowed: config().claudeAllowed, codexAllowed: codex, mode, low, namespace: pluginName });
  const notes = (row) => [row.basis === "estimated" ? "estimated" : row.basis === "none" ? "no agent benchmark; skip" : "",
    row.approval ? "needs owner approval" : "", row.dominatedBy ? `skip: ${row.dominatedBy} scores as high for less` : ""].filter(Boolean).join("; ");
  const cells = [["Worker", "Score", "Cost/try", "Min/try", "Note"], ...rows.map((row) => [row.worker,
    row.score === null ? "-" : `${row.basis === "estimated" ? "~" : ""}${row.score}`,
    row.cost === null ? "-" : `USD ${row.cost.toFixed(2)}`, row.minutes === null ? "-" : String(row.minutes), notes(row)])];
  const widths = cells[0].map((_, i) => Math.max(...cells.map((cell) => cell[i].length)));
  const table = cells.map((cell) => cell.map((text, i) => text.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
  const lines = [`Router workers (mode=${mode}; allowed by your GSwitch settings; agent benchmark per attempt)`, table];
  if (low && (mode === "claude" || mode === "mixed")) lines.push("Claude usage LOW: Claude workers left out.");
  if (text === undefined && (mode === "mixed" || mode === "codex")) lines.push("Codex workers not listed: pass --codex with the allowed models and efforts from invoke-status.");
  return lines.join("\n");
}
const recovery = {
  verify: "repair once with the same worker (resume it with the evidence), or escalate",
  review: "repair once with the same worker (resume it with the evidence), or escalate",
  incomplete: "repair once with the same worker (resume it with the evidence), or escalate",
  capability: "escalate to a candidate below", other: "escalate to a candidate below",
  context: "ask the owner if it is a product decision; otherwise retry the same worker with the missing context",
  tool: "fix the environment or verify command, then retry the same worker; do not escalate",
  scope: "decide the scope request, then resume the same worker",
  usage: "Codex: GSwitch fails over by itself; if Invoke Mode paused, stop and wait for the owner. Claude LOW: mixed uses Codex rows, claude wraps up",
  worktree: "keep the worktree, tell the owner its path and reason; retry on a fresh worktree or ask",
  stopped: "ask the owner"
};
export function sampleWorker(records, record, rows, { sampling = "on", prefer = "codex", roll = Math.random() } = {}) {
  const state = taskState(records, record.sessionId, record.task);
  const { floor, level } = taskFloor(record.kind, record.difficulty);
  if (sampling !== "on" || !["trivial", "small"].includes(record.difficulty) ||
      !["trivial", "small"].includes(level)) return null;
  const earlier = records.find((r) => r.type === "plan" && r.sessionId === record.sessionId && r.task === record.task);
  if (earlier) return earlier.sample ?? null;
  if (state.hasResults || roll >= 0.1) return null;
  const first = candidates(rows, { floor, prefer })[0];
  if (!first) return null;
  const count = (worker) => records.filter((r) => r.type === "result" && r.worker !== "orchestrator" && r.worker === worker && r.difficulty === record.difficulty).length;
  const pool = rows.filter((row) => row.worker !== first.worker && !row.approval && !needsApproval(benchmarkId(row.worker)) &&
    (row.cost === null || row.cost < first.cost));
  pool.sort((a, b) => count(a.worker) - count(b.worker) || (a.cost === null ? 0 : 1) - (b.cost === null ? 0 : 1) ||
    (a.cost ?? 0) - (b.cost ?? 0) || a.worker.localeCompare(b.worker));
  return pool[0]?.worker ?? null;
}
function sampleRoll() {
  const value = process.env.GSWITCH_ROUTER_SAMPLE_ROLL;
  const roll = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(roll) && roll >= 0 && roll <= 1 ? roll : Math.random();
}
// Codex rows come from the plan's --codex list or, without one, from GSwitch's Invoke status.
const planCodex = async (record) => record.codex == null ? codexAllowedFrom(await invokeStatus()) : codexAllowed(record.codex);
async function plan(args) {
  if (resolved().mode.value === "off") return "Router is off.";
  const at = args.indexOf("--codex");
  if (at >= 0 && (args[at + 1] === undefined || args[at + 1].startsWith("--"))) throw new Error(`--codex needs a value: "<model>:<effort>[,<effort>...][;<model>:...]"`);
  const record = planRecord(args, projectKey);
  if (record.codex != null) codexAllowed(record.codex);
  const cfg = config(), codex = await planCodex(record);
  const rows = workerTable({ claudeAllowed: cfg.claudeAllowed, codexAllowed: codex,
    mode: resolved().mode.value, low: usage()?.left <= 30, namespace: pluginName });
  record.sample = sampleWorker(readResults(data("results.jsonl")), record, rows, { sampling: cfg.sampling, prefer: cfg.prefer, roll: sampleRoll() });
  appendResult(data("results.jsonl"), record);
  const state = taskState(readResults(data("results.jsonl")), record.sessionId, record.task);
  return planView(state, codex);
}
// Allowed workers that meet the task's floor and have not failed it, in the owner's order.
function nextCandidates(state, codex) {
  const rows = workerTable({ claudeAllowed: config().claudeAllowed, codexAllowed: codex, mode: resolved().mode.value, low: usage()?.left <= 30, namespace: pluginName });
  return candidates(rows, { floor: floorFor(state).floor, exclude: state.failedWorkers.map(({ worker }) => worker), prefer: config().prefer });
}
function planView(state, codex) {
  const record = state.plan;
  const { floor, level } = floorFor(state), mode = resolved().mode.value;
  const lines = [`Plan ${record.task}: ${record.kind}, ${record.difficulty} · floor ${floor} (${level}) · ${state.failures} failed of ${ownerCheckAfter} before the owner is asked`];
  if (state.failures) lines.push(`Failed: ${failedList(state)}`);
  if (state.last?.outcome === "fail") {
    if (state.last.sample === true) lines.push("Next after a failed sample attempt: use the candidates below; do not repair the sample worker.");
    else lines.push(`Next after ${state.last.reason ?? "other"}: ${recovery[state.last.reason ?? "other"]}`);
  }
  if (state.failures >= ownerCheckAfter) lines.push(`Owner check: ask the owner before attempt ${state.failures + 1}; the launch will show an approval prompt.`);
  if (state.done) lines.push(`Task ${record.task} already passed; start a new task id for new work.`);
  else {
    const prefer = config().prefer;
    const choices = nextCandidates(state, codex).slice(0, 6);
    const order = mode !== "mixed" || prefer === "price" ? "cheapest first" : prefer === "codex" ? "Codex first, then cheapest" : "Claude first, then cheapest";
    if (!state.hasResults && record.sample) lines.push('Sample attempt (about 1 in 10 trivial/small tasks): ' + record.sample + ' — start with it to measure it; if it fails, use the candidates below. Say "sample attempt" in the report.');
    if (!choices.length) lines.push(`No allowed worker meets floor ${floor}: stop and ask the owner.`);
    else lines.push(`Candidates (${order}):`, ...choices.map((row) => `  ${row.worker}  ${row.score}  USD ${row.cost.toFixed(2)}  ${row.minutes} min${needsApproval(benchmarkId(row.worker)) ? "  needs owner approval" : ""}`));
  }
  if (!Object.keys(codex).length && ["mixed", "codex"].includes(mode)) lines.push("Codex workers not listed: pass --codex with the allowed models and efforts from invoke-status.");
  const speed = config().codexSpeed;
  if (["mixed", "codex"].includes(mode)) {
    if (speed.mode === "orchestrator") lines.push(`Codex speed: Orchestrator decides — add --speed fast --speed-reason "<why>" only when the owner is waiting on this result to continue; otherwise Normal. Fast falls back to Normal below ${speed.fastMinRemaining}% usage left.`);
    else if (speed.mode === "fast") lines.push(`Codex speed: Fast (falls back to Normal below ${speed.fastMinRemaining}% usage left)`);
  }
  lines.push(`Brief lines: TASK: ${record.task} · SCOPE: <globs> · VERIFY: <command>`);
  return lines.join("\n");
}
// Appends a result, marking a first attempt by the plan's sample worker.
function appendWorkerResult(record) {
  const before = taskState(readResults(data("results.jsonl")), record.sessionId, record.task);
  record.sample = !before.hasResults && record.worker === before.plan?.sample;
  appendResult(data("results.jsonl"), record);
  return taskState(readResults(data("results.jsonl")), record.sessionId, record.task);
}
async function recordResult(record) {
  const state = appendWorkerResult(record);
  const lines = [`Result: recorded ${record.task} ${record.worker} ${record.outcome}`];
  if (record.outcome === "fail" && state.plan) lines.push(planView(state, await planCodex(state.plan)));
  return lines.join("\n");
}
// A bound worker's result with the plan's difficulty and title; the step follows earlier results on the task.
function workerResult(id, directory, agent, bound, outcome, reason) {
  const state = taskState(readResults(data("results.jsonl")), id, bound.task);
  if (!state.plan) throw new Error(`No plan for task ${bound.task}; add KIND: and DIFFICULTY: lines to its brief.`);
  const step = !state.results.length ? "start" : state.results.some((r) => r.agentId === agent) ? "repair" : "escalation";
  return resultRecord([id, directory, "--task", bound.task, "--difficulty", state.plan.difficulty,
    "--worker", bound.type, "--outcome", outcome, ...(reason ? ["--reason", reason] : []), "--step", step, "--agent", agent,
    ...(state.plan.title ? ["--title", state.plan.title] : [])], projectKey, pluginName);
}
export function worktreeApplied(output) { return /^Worktree: applied \d+ files$/m.test(output); }
// Verifies, scope-checks and applies a stopped worker's worktree; shared by router finish and the SubagentStop hook.
// Runs outside the state lock (verify can take minutes); session writes take it, and applies wait for each other.
async function checkWorktree(id, directory, agent, bound, verify) {
  const keepLocked = worktrees(directory).find((item) => comparable(item.root) === comparable(bound.cwd))?.locked;
  const base = gitText(directory, ["merge-base", "HEAD", gitText(bound.cwd, ["rev-parse", "HEAD"])]);
  const facts = checkFacts(["--cwd", bound.cwd, "--base", base, "--scope", (bound.scope || []).join(","), ...(verify ? ["--verify", verify] : [])]);
  let applied = null;
  if (facts.verify !== "failed" && !facts.scopeWarnings) {
    applied = await locked(() => apply(["--worktree", bound.cwd, "--cwd", directory, ...(keepLocked ? ["--keep-locked"] : [])]), "apply.lock", 600000, 900000);
    if (worktreeApplied(applied)) await locked(() => {
      const current = session(id);
      current.bindings[agent].appliedAt = Date.now();
      saveSession(id, current);
    });
  }
  const finishRecord = { type: "finish", time: new Date().toISOString(), sessionId: id, project: projectKey(directory),
    task: bound.task, worker: bound.type, agentId: agent, files: facts.files, added: facts.added, deleted: facts.deleted,
    verify: facts.verify, scopeWarnings: facts.scopeWarnings, applied: applied !== null && worktreeApplied(applied) };
  return { facts, applied, finishRecord };
}
// Manual fallback for the SubagentStop check, for example after router scope approves out-of-scope files.
async function finish(args) {
  const [id, directory] = args, agent = option(args, "--agent");
  if (!id || !directory || !agent) throw new Error("finish requires <sessionId> <projectDir> --agent <agentId>");
  const sess = session(id), bound = sess.bindings[agent];
  if (!bound) throw new Error(`Worker ${agent} is not bound`);
  if (bound.appliedAt != null) return "Already applied.";
  if (!bound.task) throw new Error(`Worker ${agent} has no task`);
  const stopped = sess.finished.find((worker) => worker.agentId === agent);
  if (!stopped || (bound.resumedAt != null && !(bound.resumedAt < stopped.time))) return "Worker still running or not stopped: wait for its completion notice, then run router finish again. If it has stopped and this repeats, apply it with router apply.";
  if (!bound.cwd || !fs.existsSync(bound.cwd) || comparable(bound.cwd) === comparable(layout(directory).root)) return "Worker changed nothing (no worktree).";
  const failure = (reason) => locked(() => recordResult(workerResult(id, directory, agent, bound, "fail", reason)));
  const { facts, applied, finishRecord } = await checkWorktree(id, directory, agent, bound, option(args, "--verify") ?? bound.verify);
  const checked = facts.output;
  const capture = () => locked(() => appendResult(data("results.jsonl"), finishRecord));
  if (facts.verify === "failed") {
    const result = await failure("verify");
    await capture();
    return checked + "\n" + result;
  }
  if (facts.scopeWarnings) {
    await capture();
    return checked + "\nNot applied: decide the out-of-scope changes (approve with router scope, or record the result yourself).";
  }
  await capture();
  return `${checked}\n${applied}\n${worktreeApplied(applied) ? "Applied. Review it, then record pass (or a review failure) with router result." : await failure("worktree")}`;
}
const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
// Checks, applies and records a bound worker's attempt when it stops, then blocks it once so that its final
// message (the orchestrator's completion notice) ends with the router's verdict.
async function subagentStop(input) {
  const id = input.session_id, cwd = input.cwd || process.cwd(), agent = input.agent_id;
  const text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : transcriptText(input.agent_transcript_path);
  const start = await locked(() => {
    const sess = session(id), bound = sess.bindings[agent];
    if (!isWorker(bound?.type)) return null;
    delete bound.resumedAt;
    const pending = bound.verdictPending === true || input.stop_hook_active === true;
    delete bound.verdictPending;
    const stopped = sess.finished.find((worker) => worker.agentId === agent);
    if (stopped) stopped.time = Date.now();
    else sess.finished.push({ agentId: agent, ...bound, time: Date.now() });
    saveSession(id, sess);
    appendResult(data("results.jsonl"), { ...attemptRecord(input, { sessionId: id, project: projectKey(sess.projectDir || cwd),
      agentId: agent, worker: bound.type, task: bound.task ?? null, scope: Array.isArray(bound.scope) ? bound.scope : [] }), ...transcriptTotals(input.agent_transcript_path),
      self: parseSelfReport(text) });
    return { bound: { ...bound }, projectDir: sess.projectDir, pending };
  });
  // The second stop after our block is the worker's repeated report: let it end.
  if (!start || start.pending || !start.bound.task) return {};
  const { bound } = start;
  const plan = taskState(readResults(data("results.jsonl")), id, bound.task).plan;
  if (!plan) return {};
  let directory = start.projectDir || cwd;
  try { directory = layout(directory).root; }
  catch { try { directory = mainWorktree(bound.cwd).main; } catch {} }
  const worktree = !!bound.cwd && fs.existsSync(bound.cwd) && comparable(bound.cwd) !== comparable(directory);
  const stoppedLine = text.match(/^[\s>*`-]*STOPPED:[ \t]*([^\r\n]*)$/m)?.[1];
  let outcome = "fail", reason = null, check = null, nothing = false;
  const lines = [];
  if (/^[\s>*`-]*SCOPE REQUEST:/m.test(text)) reason = "scope";
  else if (stoppedLine !== undefined) reason = /too hard/i.test(stoppedLine) ? "capability" : /unclear brief/i.test(stoppedLine) ? "context" : /environment/i.test(stoppedLine) ? "tool" : "other";
  else {
    try {
      nothing = !worktree || checkFacts(["--cwd", bound.cwd, "--base", gitText(directory, ["merge-base", "HEAD", gitText(bound.cwd, ["rev-parse", "HEAD"])])]).files === 0;
      if (!nothing) check = await checkWorktree(id, directory, agent, bound, bound.verify);
    } catch (error) { reason = "worktree"; lines.push(`Worktree kept: ${bound.cwd} — ${error.message}`); }
    if (reason === "worktree") { /* the check itself failed; nothing applied */ }
    else if (nothing) {
      if (["research", "review"].includes(plan.kind)) outcome = "unverified";
      else reason = "incomplete";
      lines.push("Worker changed nothing.");
    } else if (check.facts.verify === "failed") {
      reason = "verify";
      lines.push(`Worktree kept: ${bound.cwd} — verify failed`, ...check.facts.verifyTail.slice(-15));
    } else if (check.facts.scopeWarnings) {
      outcome = "blocked"; reason = "scope";
      lines.push(`Worktree kept: ${bound.cwd} — changed outside SCOPE: ${check.facts.outside.join(", ")}`,
        `Approve: node ${quote(routerScript)} scope ${id} ${agent} --add ${quote(check.facts.outside.join(","))}`,
        `Then apply: node ${quote(routerScript)} finish ${id} ${quote(directory)} --agent ${agent}`);
    } else if (worktreeApplied(check.applied)) {
      outcome = check.facts.verify === "passed" ? "pass" : "unverified";
      lines.push(...check.applied.split(/\r?\n/).filter((line) => /^(Worktree|Branch) kept: /.test(line)));
    } else {
      reason = "worktree";
      lines.push(check.applied);
    }
  }
  const codex = outcome === "fail" ? await planCodex(plan) : {};
  const { record, state } = await locked(() => {
    if (check) appendResult(data("results.jsonl"), check.finishRecord);
    const record = { ...workerResult(id, directory, agent, bound, outcome, reason), source: "hook" };
    const state = appendWorkerResult(record);
    const current = session(id);
    if (current.bindings[agent]) { current.bindings[agent].verdictPending = true; saveSession(id, current); }
    return { record, state };
  });
  const applied = check?.applied && worktreeApplied(check.applied) ? `applied ${check.applied.match(/^Worktree: applied (\d+) files$/m)[1]} files` : "not applied";
  lines.unshift(`ROUTER: ${bound.task} ${bound.type} ${outcome}${reason ? ` (${reason})` : ""} · ${applied} · Verify: ${check?.facts.verifyText ?? "none"}`);
  if (outcome === "fail") {
    lines.push(`Next: ${record.sample ? "use a candidate below; do not repair the sample worker" : recovery[reason]}`);
    if (state.failures >= ownerCheckAfter) lines.push(`Owner check: ask the owner before attempt ${state.failures + 1}.`);
    const choices = nextCandidates(state, codex).slice(0, 3);
    lines.push(choices.length ? `Candidates: ${choices.map((row) => `${row.worker}${needsApproval(benchmarkId(row.worker)) ? " (needs owner approval)" : ""}`).join(" · ")}`
      : `No allowed worker meets floor ${floorFor(state).floor}: stop and ask the owner.`);
  }
  return { decision: "block", reason: `Router check done. Do not edit files or run commands. Reply with your report from before, unchanged, and end it with these lines exactly:\n${lines.join("\n")}` };
}
async function command(args, raw) {
  const [name, ...rest] = args;
  if (name === "hook") return JSON.stringify(await hook(rest[0], object(JSON.parse(raw || "{}"))));
  if (name === "check") return check(rest);
  if (name === "apply") return apply(rest);
  if (name === "finish") return finish(rest);
  if (name === "plan") return plan(rest);
  if (name === "result") {
    const record = resultRecord(rest, projectKey, pluginName);
    return recordResult(record);
  }
  if (name === "stats") {
    const records = readResults(data("results.jsonl")), options = statsOptions(rest, comparable);
    const edits = orchestratorEdits(records, options);
    options.codexRuns = readResults(path.join(appDataDirectory(home, target), "codex-runs.jsonl"));
    const table = [statsTable(aggregateStats(records, options)), ...speedComparisons(records, options)].join("\n");
    return edits ? `${table}\nOrchestrator edits (not worker attempts): ${edits}` : table;
  }
  if (name === "workers") return workers(rest);
  if (name === "statusline") return statusline(raw);
  if (name === "statusline-install" || name === "statusline-uninstall") return statuslineSettings(name === "statusline-install");
  if (name === "mode") {
    const [, directory, ...words] = rest;
    if (words.length) return "Change it in GSwitch → Claude Code.";
    const folder = projectKey(directory);
    const state = resolved();
    const lines = [routerLine(state), `Claude models it may use: ${allowedList(config().claudeAllowed, true)}`];
    if (!isRepository(folder)) lines.push(`Router warning: ${folder} is not a git repository; start the session in the repository folder.`);
    if (state.mode.value !== "off" && worktreeBaseRef(folder) !== "head") lines.push(baseRefWarning);
    lines.push("Change it in GSwitch → Claude Code.");
    return lines.join("\n");
  }
  if (name === "scope") {
    const [id, agent] = rest;
    const sess = session(id);
    if (!sess.bindings[agent]) throw new Error("Worker is not bound");
    const additions = scopes(option(rest, "--add"));
    if (!additions.length) throw new Error("scope requires --add <globs>");
    sess.bindings[agent].scope = [...new Set([...sess.bindings[agent].scope, ...additions])];
    saveSession(id, sess);
    return `Scope: ${agent} — ${sess.bindings[agent].scope.join(",")}`;
  }
  throw new Error("Unknown router command");
}
async function main() {
  const args = process.argv.slice(2);
  const isHook = args[0] === "hook";
  let input = {};
  try {
    const raw = ["hook", "statusline"].includes(args[0]) ? fs.readFileSync(0, "utf8") : "";
    // Parsed before the lock so a lock timeout can still deny a worker's edit.
    if (isHook) try { input = object(JSON.parse(raw || "{}")); } catch {}
    // Protected files and the installed plugin are checked first, for every tool and without the state lock.
    const guarded = isHook && args[1] === "PreToolUse" ? protection(input) : null;
    if (guarded) { process.stdout.write(`${JSON.stringify(guarded)}\n`); return; }
    // Commands that are not invokes never touch router state.
    const bash = isHook && ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(args[1]) && input.tool_name === "Bash";
    if ((bash && (!isInvoke(String(input.tool_input?.command || "")) || (args[1] !== "PreToolUse" && !codexLaunch(input)))) || (isHook && input.tool_name === "PowerShell")) {
      process.stdout.write("{}\n"); return;
    }
    // Git and verification operations have private indexes and need no state lock; SubagentStop and Stop take the lock
    // themselves (SubagentStop's verify can take minutes); UserPromptSubmit only reads, and locks to write.
    const unlocked = ["check", "apply", "finish", "statusline"].includes(args[0]) || (isHook && ["SubagentStop", "Stop", "UserPromptSubmit"].includes(args[1]));
    const output = unlocked ? await command(args, raw) : await locked(() => command(args, raw));
    process.stdout.write(args[0] === "statusline" ? output : `${output}\n`);
  } catch (error) {
    if (isHook) {
      try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(data("router.log"), `${new Date().toISOString()} ${args[1]}: ${error instanceof SyntaxError ? "Invalid hook JSON" : error.message}\n`); } catch {}
      // Fail closed for subagents; the orchestrator stays fail-open so a broken router never locks the owner out.
      const worker = args[1] === "PreToolUse" && typeof input.agent_id === "string" && input.agent_id;
      process.stdout.write(`${worker ? JSON.stringify(decision("deny", `Router error: ${error.message}. Do not edit; stop and report this error.`)) : "{}"}\n`);
    } else { process.stderr.write(`Router: ${error.message}\n`); process.exitCode = 1; }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
