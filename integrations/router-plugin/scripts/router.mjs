// Added by Light505 for gswitchtool (2026).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { models, efforts, prefers, workerNames, defaultAllowed, needsApproval, workerTable, benchmarks, benchmarkId, taskFloor, candidates, ownerCheckAfter } from "./workers.mjs";
import { appendResult, readResults, resultRecord, planRecord, taskState, attemptRecord, transcriptTotals, aggregateStats, orchestratorEdits, statsOptions, statsTable } from "./results.mjs";

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
const directoryName = (value, fallback) => typeof value === "string" && /^[\w.-]+$/.test(value) && ![".", ".."].includes(value)
  ? value : fallback;
const dataName = directoryName(target.dataDir, ".gswitchtool-router");
const dataDir = path.join(home, dataName);
const setupFile = path.join(home, directoryName(target.appDataDir, ".gswitchtool"), "claude-setup.json");
const pluginName = readJSON(path.join(pluginRoot, ".claude-plugin", "plugin.json")).name || "router";
const data = (...parts) => path.join(dataDir, ...parts);

function atomicJSON(file, value, indent = 2, newline = "\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, indent).replace(/\n/g, newline)}${newline}`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Serialize read/modify/write across hook processes, not merely each rename.
async function locked(action) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lock = data("state.lock");
  const started = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A terminated hook must not permanently prevent state updates.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmdirSync(lock); } catch {}
      if (Date.now() - started > 10000) throw new Error("Router state is busy");
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
function allowedList(allowed = config().claudeAllowed) {
  return models.filter(({ short }) => allowed[short]?.length)
    .map(({ short }) => `${short} ${allowed[short].join(", ")}`).join(" · ") || "none";
}
function config() {
  const setup = readJSON(setupFile);
  const valid = setup.version === 1 && ["claude-only", "claude-codex", "router"].includes(setup.setup) &&
    modes.slice(1).includes(setup.router?.mode) && reviews.includes(setup.router?.claudeOnlyReview);
  const value = valid ? setup.router : {};
  return { mode: valid && setup.setup === "router" ? value.mode : "off",
    prefer: prefers.includes(value.prefer) ? value.prefer : "codex",
    claudeOnlyReview: value.claudeOnlyReview ?? "on", claudeAllowed: claudeAllowed(value.claudeAllowed) };
}
// Only status-line passthrough state remains in the router's old config file.
function statuslineConfig() {
  const { statusLinePrevious, statusLineCommand } = readJSON(data("config.json"));
  return { statusLinePrevious, statusLineCommand };
}
function sessionFile(id) {
  if (!id) throw new Error("A session ID is required");
  return data("sessions", `${/^[\w-]+$/.test(id) ? id : hash(id)}.json`);
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
    review: { value: cfg.claudeOnlyReview, source: "GSwitch setup" }, prefer: cfg.prefer };
}
function routerLine(state) {
  const label = { off: "Off", mixed: "Mixed", codex: "Codex only", claude: "Claude only" }[state.mode.value];
  const prefer = { codex: "Codex", claude: "Claude", price: "Lowest API price" }[state.prefer];
  return `Router: ${label} (${state.mode.source}) · Codex review: ${state.review.value} (${state.review.source})${state.mode.value === "mixed" ? ` · Use first: ${prefer} (${state.mode.source})` : ""}`;
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
function usageLine() {
  const window = usage();
  return window ? `Claude 5h usage: ${window.left}% left, resets ${new Date(window.reset).toLocaleString()}` : "Claude 5h usage: unknown";
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
function wrapupFile(directory) { return data("wrapups", `${hash(comparable(directory))}.json`); }
// An inline invoke brief starts right after its opening quote.
const taskId = (text) => String(text || "").match(/(?:^|["'])[ \t]*TASK:[ \t]*([\w.-]{1,40})[ \t]*["']?[ \t]*$/m)?.[1];
const failedList = (state) => state.results.filter((r) => r.outcome === "fail").map((r) => `${r.worker} (${r.reason ?? "other"})`).join(", ");
const floorFor = (state) => taskFloor(state.plan.kind, state.plan.difficulty,
  state.failedWorkers.map(({ worker }) => benchmarks[benchmarkId(worker)]?.score), state.failedWorkers.length);
function taskLaunch(id, task, type, title, repair = false) {
  const state = taskState(readResults(data("results.jsonl")), id, task);
  const sess = session(id);
  const launches = [...Object.values(sess.bindings).filter((b) => isWorker(b.type) && b.task === task).map((b) => ({ worker: b.type, time: b.time ?? 0 })),
    ...sess.codexLaunches.filter((launch) => launch.task === task)].sort((a, b) => a.time - b.time);
  const latest = launches.at(-1);
  if (latest && !state.results.some((r) => Date.parse(r.time) >= latest.time)) return decision("deny", `Record the result of the previous attempt on task ${task} (${latest.worker}) with router result first.`);
  if (!state.plan) return decision("deny", `Run router plan for task ${task} first.`);
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
const invokePath = (command) => command.match(/(?:^|[\n;|(]|&&|\|\|)[ \t]*node(?:\.exe)?["']?\s+((?:"[^"]*|'[^']*|[^\s"']*)codex-companion\.mjs)["']?\s+invoke(?:\s|$)/)?.[1];
const isInvoke = (command) => {
  const companion = invokePath(command);
  return companion !== undefined && /(?:^|["'\\/])codex-dev[\\/]/.test(companion) === (pluginName === "router-dev");
};
function invokeTask(command, cwd) {
  let task = taskId(command);
  const file = shellOption(command, ["--prompt-file"]);
  if (!task && file) {
    const directory = shellOption(command, ["--cwd"]);
    try { task = taskId(fs.readFileSync(path.resolve(directory ? path.resolve(cwd, directory) : cwd, file), "utf8")); }
    catch { return undefined; }
  }
  return task;
}
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
function hook(event, input) {
  const command = String(input.tool_input?.command || "");
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) && input.tool_name === "Bash" && !isInvoke(command)) return {};
  // Expire old worker state, including a resumed session with this ID.
  if (event === "SessionStart" && fs.existsSync(data("sessions"))) for (const name of fs.readdirSync(data("sessions"))) {
    const file = data("sessions", name);
    if (name.endsWith(".json") && fs.statSync(file).mtimeMs < Date.now() - 7 * 86400000) fs.rmSync(file);
  }
  const id = input.session_id;
  const cwd = input.cwd || process.cwd();
  const sess = session(id);
  const state = resolved();
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
  if (event === "SubagentStop" && isWorker(sess.bindings[input.agent_id]?.type)) {
    const bound = sess.bindings[input.agent_id];
    delete bound.resumedAt;
    const stopped = sess.finished.find((worker) => worker.agentId === input.agent_id);
    if (stopped) stopped.time = Date.now();
    else sess.finished.push({ agentId: input.agent_id, ...bound, time: Date.now() });
    saveSession(id, sess);
    appendResult(data("results.jsonl"), { ...attemptRecord(input, { sessionId: id, project: projectKey(sess.projectDir || cwd),
      agentId: input.agent_id, worker: bound.type, task: bound.task ?? null, scope: Array.isArray(bound.scope) ? bound.scope : [] }), ...transcriptTotals(input.agent_transcript_path) });
    return {};
  }
  if (event === "SessionStart") {
    const lines = state.mode.value === "off" ? [] : [routerLine(state)];
    if (state.mode.value !== "off" && worktreeBaseRef(cwd) !== "head") lines.push(baseRefWarning);
    if (fs.existsSync(wrapupFile(cwd))) lines.push(`Router: unfinished work saved; run node "${path.join(pluginRoot, "scripts", "router.mjs")}" wrapup show "${cwd}".`);
    const model = typeof input.model === "string" ? input.model : input.model?.id;
    if (state.mode.value !== "off" && model && !/opus/i.test(model)) lines.push("Router warning: use an Opus model for the orchestrator.");
    return context(event, lines.join("\n"));
  }
  if (event === "UserPromptSubmit") {
    if (state.mode.value === "off") return {};
    const window = usage();
    return context(event, `Router: mode=${state.mode.value} (${state.mode.source}) · Codex review in claude mode: ${state.review.value}${state.mode.value === "mixed" ? ` · Use first: ${state.prefer}` : ""} · Claude 5h: ${window ? `${window.left}% left` : "unknown"}${window && window.left <= 30 ? " · LOW: no Claude workers" : ""} · Claude workers: ${allowedList()}`);
  }
  if (event === "PreToolUse" && input.tool_name === "SendMessage") {
    const bound = sess.bindings[input.tool_input?.to];
    if (!bound) return {};
    bound.resumedAt = Date.now();
    delete bound.appliedAt;
    saveSession(id, sess);
    if (state.mode.value === "off" || !bound.task) return {};
    const task = taskState(readResults(data("results.jsonl")), id, bound.task);
    return task.failures >= ownerCheckAfter && !task.done
      ? decision("ask", `Task ${bound.task} has ${task.failures} failed attempts; continue by resuming ${bound.type}?`) : {};
  }
  if (state.mode.value === "off") return {};
  if (event === "PreToolUse" && input.tool_name === "Bash") {
    if (sess.bindings[input.agent_id]) return decision("deny", "Router workers cannot start other agents.");
    const task = invokeTask(command, cwd);
    if (!task) return {};
    if (state.mode.value === "claude" && /(?:^|\s)--write(?:\s|$)/.test(command)) return decision("deny", "Claude mode: Codex does not write code; use a Claude worker.");
    const type = codexWorker(command);
    if (!type) return {};
    return taskLaunch(id, task, type, command.split(/\r?\n/)[0], /(?:^|\s)--resume-thread(?:\s|$)/.test(command));
  }
  if (event === "PreToolUse" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(input.tool_name)) {
    const bound = sess.bindings[input.agent_id];
    if (!bound) return isWorker(input.agent_type) ? decision("deny", "Router has no scope for this worker; stop and report.") : {};
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
    if (!task) return decision("deny", "Add a line TASK: <id> to the worker prompt (run router plan first).");
    const permission = taskLaunch(id, task, type, String(tool.description || tool.prompt || "worker task").split(/\r?\n/)[0]);
    if (permission.hookSpecificOutput?.permissionDecision === "deny") return permission;
    // Record ask launches too: SubagentStart happens only after approval.
    sess.projectDir = sess.projectDir || projectKey(cwd);
    sess.pending.push({ type, scope, task, time: Date.now() });
    saveSession(id, sess);
    return permission;
  }
  if (event === "SubagentStart" && isWorker(input.agent_type) && input.agent_id) {
    const pending = sess.pending.map((launch, index) => ({ launch, index })).filter(({ launch }) => launch.type === input.agent_type).sort((a, b) => a.launch.time - b.launch.time)[0];
    if (pending) {
      sess.pending.splice(pending.index, 1);
      sess.bindings[input.agent_id] = { type: input.agent_type, scope: pending.launch.scope, task: pending.launch.task ?? null, cwd, time: Date.now() };
      saveSession(id, sess);
    }
    if (input.cwd) sharedDependencies(cwd, sess.projectDir);
  }
  return {};
}

function option(args, name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
function check(args) {
  const cwd = option(args, "--cwd");
  if (!cwd) throw new Error("check requires --cwd");
  const verify = option(args, "--verify");
  const lines = [];
  if (verify) {
    const started = Date.now();
    const result = spawnSync(verify, { cwd, shell: true, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    lines.push(result.status === 0 ? `Verify: passed (${verify}, ${Math.round((Date.now() - started) / 1000)}s)` : `Verify: FAILED (exit ${result.status ?? 127})`);
    if (result.status !== 0) lines.push(...`${result.stdout || ""}${result.stderr || ""}${result.error?.message || ""}`.trimEnd().split(/\r?\n/).slice(-40));
  }
  let root;
  try { root = layout(cwd).root; } catch { return [...lines, "git: not a repository"].join("\n"); }
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
  if (scope.length) for (const file of facts) if (!scope.some((pattern) => matchesScope(file.path, pattern))) lines.push(`WARNING: changed outside --scope: ${file.path}`);
  const shown = facts.slice(0, 20).map((file) => `${file.path} (+${file.added} −${file.deleted})`).join(", ") || "none";
  lines.push(`Changed files (git): ${shown}${facts.length > 20 ? `, and ${facts.length - 20} more` : ""}; ${facts.length} files, +${facts.reduce((sum, file) => sum + file.added, 0)} −${facts.reduce((sum, file) => sum + file.deleted, 0)}`);
  return lines.join("\n");
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
function plan(args) {
  if (resolved().mode.value === "off") return "Router is off.";
  const at = args.indexOf("--codex");
  if (at >= 0 && (args[at + 1] === undefined || args[at + 1].startsWith("--"))) throw new Error(`--codex needs a value: "<model>:<effort>[,<effort>...][;<model>:...]"`);
  const record = planRecord(args, projectKey);
  if (record.codex != null) codexAllowed(record.codex);
  appendResult(data("results.jsonl"), record);
  const state = taskState(readResults(data("results.jsonl")), record.sessionId, record.task);
  return planView(state);
}
function planView(state) {
  const record = state.plan, text = record.codex;
  const codex = text == null ? {} : codexAllowed(text);
  const { floor, level } = floorFor(state), mode = resolved().mode.value;
  const lines = [`Plan ${record.task}: ${record.kind}, ${record.difficulty} · floor ${floor} (${level}) · ${state.failures} failed of ${ownerCheckAfter} before the owner is asked`];
  if (state.failures) lines.push(`Failed: ${failedList(state)}`);
  if (state.last?.outcome === "fail") lines.push(`Next after ${state.last.reason ?? "other"}: ${recovery[state.last.reason ?? "other"]}`);
  if (state.failures >= ownerCheckAfter) lines.push(`Owner check: ask the owner before attempt ${state.failures + 1}; the launch will show an approval prompt.`);
  if (state.done) lines.push(`Task ${record.task} already passed; start a new task id for new work.`);
  else {
    const rows = workerTable({ claudeAllowed: config().claudeAllowed, codexAllowed: codex, mode, low: usage()?.left <= 30, namespace: pluginName });
    const prefer = config().prefer;
    const choices = candidates(rows, { floor, exclude: state.failedWorkers.map(({ worker }) => worker), prefer }).slice(0, 6);
    const order = mode !== "mixed" || prefer === "price" ? "cheapest first" : prefer === "codex" ? "Codex first, then cheapest" : "Claude first, then cheapest";
    if (!choices.length) lines.push(`No allowed worker meets floor ${floor}: stop and ask the owner.`);
    else lines.push(`Candidates (${order}):`, ...choices.map((row) => `  ${row.worker}  ${row.score}  USD ${row.cost.toFixed(2)}  ${row.minutes} min${needsApproval(benchmarkId(row.worker)) ? "  needs owner approval" : ""}`));
  }
  if (text == null && ["mixed", "codex"].includes(mode)) lines.push("Codex workers not listed: pass --codex with the allowed models and efforts from invoke-status.");
  lines.push(`Brief lines: TASK: ${record.task} · SCOPE: <globs> · VERIFY: <command>`);
  return lines.join("\n");
}
function recordResult(record) {
  appendResult(data("results.jsonl"), record);
  const lines = [`Result: recorded ${record.task} ${record.worker} ${record.outcome}`];
  const state = taskState(readResults(data("results.jsonl")), record.sessionId, record.task);
  if (record.outcome === "fail" && state.plan) lines.push(planView(state));
  return lines.join("\n");
}
export function worktreeApplied(output) { return /^Worktree: applied \d+ files$/m.test(output); }
// Runs outside the state lock (verify can take minutes); session writes and failures take it.
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
  const entry = worktrees(directory).find((item) => comparable(item.root) === comparable(bound.cwd));
  const keepLocked = entry?.locked;
  const failure = (reason) => locked(() => {
    const state = taskState(readResults(data("results.jsonl")), id, bound.task);
    if (!state.plan) throw new Error(`Run router plan for task ${bound.task} first.`);
    const step = !state.results.length ? "start" : state.results.some((r) => r.agentId === agent) ? "repair" : "escalation";
    const record = resultRecord([id, directory, "--task", bound.task, "--difficulty", state.plan.difficulty,
      "--worker", bound.type, "--outcome", "fail", "--reason", reason, "--step", step, "--agent", agent,
      ...(state.plan.title ? ["--title", state.plan.title] : [])], projectKey, pluginName);
    return recordResult(record);
  });
  const verify = option(args, "--verify");
  const base = gitText(directory, ["merge-base", "HEAD", gitText(bound.cwd, ["rev-parse", "HEAD"])]);
  const checked = check(["--cwd", bound.cwd, "--base", base, "--scope", (bound.scope || []).join(","), ...(verify ? ["--verify", verify] : [])]);
  if (/^Verify: FAILED/m.test(checked)) return `${checked}\n${await failure("verify")}`;
  if (/^WARNING: changed outside --scope/m.test(checked)) return `${checked}\nNot applied: decide the out-of-scope changes (approve with router scope, or record the result yourself).`;
  const applied = apply(["--worktree", bound.cwd, "--cwd", directory, ...(keepLocked ? ["--keep-locked"] : [])]);
  if (worktreeApplied(applied)) await locked(() => {
    const current = session(id);
    current.bindings[agent].appliedAt = Date.now();
    saveSession(id, current);
  });
  return `${checked}\n${applied}\n${worktreeApplied(applied) ? "Applied. Review it, then record pass (or a review failure) with router result." : await failure("worktree")}`;
}
function command(args, raw) {
  const [name, ...rest] = args;
  if (name === "hook") return JSON.stringify(hook(rest[0], object(JSON.parse(raw || "{}"))));
  if (name === "check") return check(rest);
  if (name === "apply") return apply(rest);
  if (name === "finish") return finish(rest);
  if (name === "usage") return usageLine();
  if (name === "plan") return plan(rest);
  if (name === "result") {
    const record = resultRecord(rest, projectKey, pluginName);
    return recordResult(record);
  }
  if (name === "stats") {
    const records = readResults(data("results.jsonl")), options = statsOptions(rest, comparable);
    const edits = orchestratorEdits(records, options);
    const table = statsTable(aggregateStats(records, options));
    return edits ? `${table}\nOrchestrator edits (not worker attempts): ${edits}` : table;
  }
  if (name === "workers") return workers(rest);
  if (name === "statusline") return statusline(raw);
  if (name === "statusline-install" || name === "statusline-uninstall") return statuslineSettings(name === "statusline-install");
  if (name === "mode") {
    const [, directory, ...words] = rest;
    if (words.length) return "Change the setup in GSwitch: Claude Code button.";
    const folder = projectKey(directory);
    const state = resolved();
    const lines = [routerLine(state), `Claude workers allowed: ${allowedList()}`];
    if (!isRepository(folder)) lines.push(`Router warning: ${folder} is not a git repository; start the session in the repository folder.`);
    if (state.mode.value !== "off" && worktreeBaseRef(folder) !== "head") lines.push(baseRefWarning);
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
  if (name === "wrapup") {
    const [action, first, second] = rest;
    const directory = action === "save" ? second : first;
    if (!directory) throw new Error("wrapup requires a project directory");
    const file = wrapupFile(directory);
    if (action === "clear") { fs.rmSync(file, { force: true }); return "Wrapup: cleared"; }
    if (action === "show") return fs.existsSync(file) ? JSON.stringify(readJSON(file), null, 2) : "Wrapup: none";
    if (action === "save") {
      const source = option(rest, "--file");
      if (!source) throw new Error("wrapup save requires --file <json>");
      const record = object(JSON.parse(fs.readFileSync(source, "utf8").replace(/^\uFEFF/, "")));
      atomicJSON(file, { ...record, sessionId: first, projectDir: projectKey(directory), updatedAt: new Date().toISOString() });
      return "Wrapup: saved";
    }
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
    // Git and verification operations have private indexes and need no state lock.
    const readHook = isHook && args[1] === "PreToolUse" && input.tool_name === "Bash";
    if (isHook && ["PostToolUse", "PostToolUseFailure"].includes(args[1]) && input.tool_name === "Bash" && !codexLaunch(input)) {
      process.stdout.write("{}\n"); return;
    }
    const output = readHook || ["check", "apply", "finish", "usage", "statusline"].includes(args[0]) ? await command(args, raw) : await locked(() => command(args, raw));
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
