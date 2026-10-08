// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { difficulties, difficultyFloor, failureReasons, benchmarkId, needsApproval, taskFloor, candidates, workerTable, defaultAllowed } from "../scripts/workers.mjs";
import { planRecord, taskState, readResults, appendResult, aggregateStats, validResult, orchestratorEdits } from "../scripts/results.mjs";

const script = fileURLToPath(new URL("../scripts/router.mjs", import.meta.url));
const codex = "gpt-6.1-sol:low,medium,high;gpt-6-luna:low,medium,high,xhigh,max";
const codexAllowed = { "gpt-6.1-sol": ["low", "medium", "high"], "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"] };
function fixture(t, mode = "mixed") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-policy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home }, project = path.join(home, "project with spaces");
  const data = path.join(home, ".gswitchtool-router"), file = path.join(data, "results.jsonl");
  fs.mkdirSync(project);
  function write(name, value) {
    const dest = path.join(data, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(value));
  }
  function setup(mode, claudeAllowed) {
    const directory = path.join(home, ".gswitchtool"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "claude-setup.json"), JSON.stringify({ version: 1, setup: mode === "off" ? "claude-only" : "router", router: { mode, claudeOnlyReview: "on", ...(claudeAllowed ? { claudeAllowed } : {}) } }));
  }
  setup(mode);
  const invoke = (args, input = "") => spawnSync(process.execPath, [script, ...args], { cwd: home, env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", windowsHide: true });
  const run = (args, input) => { const r = invoke(args, input); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const plan = (difficulty = "small", flags = [], task = "t1") => run(["plan", "s1", project, "--task", task, "--kind", "implement", "--difficulty", difficulty, ...flags]);
  const result = (worker = "router:haiku-low", reason = "verify", outcome = "fail", flags = []) => run(["result", "s1", project, "--task", "t1", "--difficulty", "small", "--worker", worker, "--outcome", outcome, ...(reason ? ["--reason", reason] : []), ...flags]);
  const hook = (tool_name, tool_input, extra = {}, event = "PreToolUse") => JSON.parse(run(["hook", event], { session_id: "s1", cwd: project, tool_name, tool_input, ...extra }));
  const agent = (type = "router:haiku-low", prompt = "Do work\nTASK: t1\nSCOPE: src/*") => hook("Agent", { subagent_type: type, prompt });
  const bash = (command, extra) => hook("Bash", { command }, extra);
  return { home, project, data, file, write, setup, invoke, run, plan, result, hook, agent, bash };
}
const permission = (r) => r.hookSpecificOutput?.permissionDecision;
const reason = (r) => r.hookSpecificOutput?.permissionDecisionReason;
const invokeCommand = (flags = "", task = true) => `node "codex-companion.mjs" invoke --model "gpt-6.1-sol" --effort 'low' ${flags}${task ? "\nTASK: t1" : ""}`;

test("floors, kind minima, distinct worker escalation and benchmark identities", () => {
  for (const difficulty of difficulties) assert.deepEqual(taskFloor("implement", difficulty), { floor: difficultyFloor[difficulty], level: difficulty });
  assert.equal(taskFloor("debug", "small").floor, 42);
  assert.equal(taskFloor("architecture", "moderate").floor, 55);
  assert.equal(taskFloor("docs", "trivial").floor, 0);
  assert.deepEqual(taskFloor("implement", "hard", [], 20), { floor: 60, level: "high-risk" });
  assert.equal(taskFloor("implement", "small", [61], 1).floor, 62);
  for (const [worker, id] of [["router:sonnet-low", "sonnet-low"], ["router-dev:opus-high", "opus-high"], ["codex:gpt-6.1-sol/low", "codex:gpt-6.1-sol/low"], ["codex-dev:gpt-6.1-sol/max", "codex:gpt-6.1-sol/max"], ["other", null]]) assert.equal(benchmarkId(worker), id);
  assert.equal(needsApproval("codex:gpt-6.1-sol/max"), true);
  assert.equal(needsApproval("codex-dev:gpt-6.1-sol/max"), true);
  assert.equal(needsApproval("codex:gpt-6-luna/low"), false);
  assert.equal(needsApproval("unknown"), true);
  const plan = { type: "plan", sessionId: "s", task: "t", kind: "implement", difficulty: "trivial" };
  const r = { type: "result", sessionId: "s", task: "t", project: "p", time: new Date().toISOString(), difficulty: "small", worker: "router:haiku-low", outcome: "fail" };
  const state = taskState([plan, r, { ...r, reason: "review" }, { ...r, worker: "router:haiku-medium", reason: "tool" }, { ...r, worker: "router:sonnet-low", reason: "capability" }], "s", "t");
  assert.equal(state.failures, 4); assert.equal(state.failedWorkers.length, 2);
  assert.deepEqual(state.failedWorkers[0].reasons, ["other", "review"]);
  assert.equal(taskFloor(plan.kind, plan.difficulty, [], state.failedWorkers.length).level, "moderate");
  assert.equal(taskState([plan, { ...plan, difficulty: "hard" }, { ...r, worker: "orchestrator", outcome: "pass" }, { ...r, sessionId: "other", outcome: "pass" }], "s", "t").plan.difficulty, "hard");
  assert.equal(taskState([], "s", "t").last, null);
  assert.equal(taskState([{ type: "result", sessionId: "s", task: "t", worker: "router:haiku-low", outcome: "fail" }], "s", "t").failures, 1);
});

test("candidates honor listed rows, floors, exclusions, domination and cheapest order", () => {
  for (const [mode, difficulty, worker] of [["mixed", "small", "router:haiku-low"], ["mixed", "moderate", "router:sonnet-low"], ["mixed", "hard", "codex:gpt-6.1-sol/low"], ["mixed", "high-risk", "codex:gpt-6.1-sol/medium"], ["claude", "hard", "router:sonnet-high"], ["claude", "high-risk", "router:opus-medium"], ["codex", "moderate", "codex:gpt-6.1-sol/low"]]) {
    const rows = workerTable({ mode, claudeAllowed: defaultAllowed(), codexAllowed });
    const choices = candidates(rows, taskFloor("implement", difficulty));
    assert.equal(choices[0].worker, worker);
    assert.ok(choices.every((row) => rows.includes(row) && row.basis !== "none" && row.score >= difficultyFloor[difficulty]));
    assert.ok(choices.every((row, i) => !i || row.cost >= choices[i - 1].cost));
    assert.ok(!choices.some((row) => choices.some((other) => other.worker === row.dominatedBy)));
  }
  const mixed = workerTable({ mode: "mixed", claudeAllowed: defaultAllowed(), codexAllowed: { "gpt-6-luna": ["max"] } });
  assert.deepEqual(candidates(mixed, taskFloor("implement", "small")).slice(0, 3).map((row) => row.worker),
    ["router:haiku-low", "codex:gpt-6-luna/max", "router:haiku-medium"]);
  const rows = workerTable({ mode: "codex", codexAllowed });
  const exclude = ["codex:gpt-6.1-sol/low", "codex:gpt-6.1-sol/medium"];
  assert.deepEqual(candidates(rows, { ...taskFloor("implement", "moderate", [57, 61], 2), exclude }), []);
  assert.equal(candidates(rows, { floor: 42, exclude: [exclude[1]] }).at(-1).worker, "codex:gpt-6.1-sol/high");
  const custom = workerTable({ mode: "claude", claudeAllowed: { opus: ["high"] } });
  assert.deepEqual(candidates(custom, { floor: 0 }).map((r) => r.worker), ["router:opus-high"]);
  const ties = [{ worker: "a", basis: "measured", score: 50, cost: 1, minutes: 10 }, { worker: "b", basis: "measured", score: 60, cost: 1, minutes: 12 }, { worker: "c", basis: "measured", score: 60, cost: 1, minutes: 8 }];
  assert.deepEqual(candidates(ties, { floor: 0 }).map((r) => r.worker), ["c", "b", "a"]);
});

test("plan prints mode decisions, appends records, refuses off and drops LOW rows", (t) => {
  const f = fixture(t, "claude");
  const out = f.plan();
  assert.match(out, /^Plan t1: implement, small · floor 0 \(small\) · 0 failed of 3 before the owner is asked\nCandidates \(cheapest first\):\n  router:haiku-low  28  USD 0.14  11.6 min\n/);
  assert.ok(out.endsWith("Brief lines: TASK: t1 · SCOPE: <globs> · VERIFY: <command>\n"));
  assert.doesNotMatch(out, /Codex workers not listed/);
  assert.ok(out.split("\n").filter((line) => line.startsWith("  ")).length <= 6);
  assert.equal(readResults(f.file)[0].type, "plan");
  f.plan("hard", ["--title", "Design"]);
  assert.equal(taskState(readResults(f.file), "s1", "t1").plan.title, "Design");
  assert.equal(readResults(f.file).length, 2);
  f.setup("mixed"); assert.match(f.plan(), /Codex workers not listed/);
  assert.match(f.plan("hard", ["--codex", codex]), /  codex:gpt-6.1-sol\/low  57  USD 0.50/);
  assert.match(f.plan("small", ["--codex", "gpt-6-luna:max"]), /  codex:gpt-6-luna\/max[^\n]*\n  router:haiku-medium/);
  f.write("usage.json", { fiveHour: { usedPercentage: 80, resetsAt: Date.now() / 1000 + 3600 } });
  assert.doesNotMatch(f.plan("small", ["--codex", codex]), /  router:/);
  f.setup("codex"); assert.doesNotMatch(f.plan("moderate", ["--codex", codex]), /  router:/);
  assert.match(f.plan(), /No allowed worker meets floor/);
  f.setup("claude"); assert.match(f.plan(), /No allowed worker meets floor/);
  const before = fs.readFileSync(f.file, "utf8"); f.setup("off");
  assert.equal(f.plan(), "Router is off.\n"); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("plan rejects invalid, unknown, duplicate and missing fields without append", (t) => {
  const f = fixture(t); f.plan(); const before = fs.readFileSync(f.file, "utf8");
  const base = ["plan", "s1", f.project, "--task", "t1", "--kind", "implement", "--difficulty", "small"];
  for (const [flag, value] of [["--kind", "bogus"], ["--difficulty", "large"], ["--task", "a b"], ["--task", "x".repeat(41)]]) {
    const args = base.map((v, i) => i === base.indexOf(flag) + 1 ? value : v);
    assert.equal(f.invoke(args).status, 1);
  }
  for (const flags of [["--title", "x".repeat(121)], ["--task", "t2"], ["--unknown", "a"], ["--title"], ["--codex", "gpt-6.1-sol:turbo"], ["--codex", "bad"], ["--codex"]]) assert.equal(f.invoke([...base, ...flags]).status, 1);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.throws(() => planRecord([], (v) => v), /plan requires/);
  assert.throws(() => planRecord(["s", "p", "--kind", "debug", "--difficulty", "small"], (v) => v), /task id/);
});

test("plan prints recovery for every reason, owner check and done without candidates", (t) => {
  const f = fixture(t, "claude");
  const words = { verify: "repair once", review: "repair once", incomplete: "repair once", capability: "escalate to a candidate below", other: "escalate to a candidate below", context: "ask the owner if it is a product decision", tool: "fix the environment or verify command", scope: "decide the scope request", usage: "Codex: GSwitch fails over by itself", worktree: "keep the worktree", stopped: "ask the owner" };
  for (const r of failureReasons) {
    fs.rmSync(f.file, { force: true }); f.plan(); f.result("router:haiku-low", r);
    const out = f.plan(); assert.ok(out.includes(`Next after ${r}: ${words[r]}`));
    assert.match(out, new RegExp(`Failed: router:haiku-low \\(${r}\\)`));
  }
  f.result("router:haiku-medium", "context"); f.result("router:sonnet-low", "tool");
  assert.match(f.plan(), /Owner check: ask the owner before attempt 4; the launch will show an approval prompt\./);
  f.result("router:opus-medium", null, "unverified");
  const out = f.plan(); assert.match(out, /Task t1 already passed; start a new task id for new work\./);
  assert.doesNotMatch(out, /Candidates|No allowed worker/);
});

test("results accept outcomes, steps and reasons; stats skip blocked and pass unverified", (t) => {
  const f = fixture(t);
  for (const outcome of ["pass", "fail", "unverified", "blocked"]) for (const step of ["start", "escalation", "repair", "retry"]) f.result("router:haiku-low", outcome === "fail" ? "incomplete" : null, outcome, ["--step", step]);
  for (const r of failureReasons) f.result("router:haiku-low", r);
  const records = readResults(f.file); assert.ok(records.every(validResult));
  const stats = aggregateStats(records)[0]; assert.equal(stats.attempts, 12 + failureReasons.length); assert.equal(stats.passes, 8);
  assert.equal(orchestratorEdits(records.map((r) => ({ ...r, worker: "orchestrator" }))), records.length);
  const before = fs.readFileSync(f.file, "utf8");
  const r = f.invoke(["result", "s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "router:haiku-low", "--outcome", "fail"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /A failed result needs --reason/);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("task floors rise once per distinct worker failure and stay unchanged for environment causes", (t) => {
  const f = fixture(t, "mixed"); f.plan();
  f.result("router:haiku-low", "tool");
  assert.match(f.plan(), /floor 0 \(small\)/);
  assert.deepEqual(f.agent(), {});
  f.result("router:haiku-low", "verify");
  assert.match(f.plan(), /floor 42 \(moderate\)/);
  f.result("router:haiku-low", "review", "fail", ["--step", "repair"]);
  const out = f.plan(); assert.match(out, /floor 42 \(moderate\)/);
  assert.match(out, /Owner check: ask the owner before attempt 4/);
  f.result("router:sonnet-high", "capability");
  assert.match(f.plan(), /floor 56 \(hard\)/);
  f.setup("codex"); fs.rmSync(f.file); f.plan("moderate", ["--codex", codex]);
  f.result("codex:gpt-6.1-sol/low", "verify"); f.result("codex:gpt-6.1-sol/medium", "review");
  assert.match(f.plan("moderate", ["--codex", codex]), /No allowed worker meets floor 62/);
});

test("Claude launch requires TASK and plan, enforces done and failed workers, binds task", (t) => {
  const f = fixture(t, "claude");
  assert.equal(reason(f.agent(undefined, "SCOPE: src/*")), "Add a line TASK: <id> to the worker prompt (run router plan first).");
  assert.equal(reason(f.agent()), "Run router plan for task t1 first.");
  f.plan(); assert.deepEqual(f.agent(), {});
  f.hook(undefined, undefined, { agent_id: "a1", agent_type: "router:haiku-low" }, "SubagentStart");
  const sess = JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8"));
  assert.equal(sess.bindings.a1.task, "t1");
  f.hook("Agent", { subagent_type: "router:haiku-low", prompt: "TASK: t1\nSCOPE: src/*" }, { tool_response: { agentId: "a1" } }, "PostToolUse");
  f.hook(undefined, undefined, { agent_id: "a1" }, "SubagentStop");
  assert.ok(readResults(f.file).filter((r) => r.type === "attempt").every((r) => r.task === "t1"));
  f.result(); assert.equal(permission(f.agent()), "deny"); assert.match(reason(f.agent()), /already failed task t1 \(verify\)/);
  f.result("router:sonnet-low", null, "pass"); assert.match(reason(f.agent("router:opus-medium")), /already passed/);
});

test("Claude launch asks for floors, cost and three failures in one decision", (t) => {
  const f = fixture(t, "claude"); f.plan("high-risk", ["--title", "Fix parser"]);
  assert.match(reason(f.agent()), /scores 28, below floor 60/);
  f.result("router:haiku-medium", "tool"); f.result("router:sonnet-low", "context");
  assert.deepEqual(f.agent("router:opus-medium"), {});
  f.result("router:sonnet-medium", "scope");
  assert.match(reason(f.agent("router:opus-medium")), /Task t1 has 3 failed attempts/);
  f.setup("claude", { haiku: ["max"], opus: ["high"] });
  const r = f.agent("router:haiku-max"); assert.equal(permission(r), "ask");
  assert.match(reason(r), /below floor 60.* · Task t1 has 3 failed attempts.* · Approve router:haiku-max for task: Fix parser/);
  assert.match(reason(f.agent("router:opus-high")), /Approve router:opus-high/);
  assert.match(reason(f.agent("router:sonnet-high")), /is not allowed/);
  f.setup("codex"); assert.equal(reason(f.agent()), "Codex mode denies Claude workers; send this to Codex.");
});

test("Bash fast path ignores broken storage and direct invokes without TASK", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.data, "broken");
  assert.deepEqual(f.bash("node other.mjs", { agent_id: "a1" }), {});
  assert.deepEqual(f.bash("node codex-companion.mjs invoke-status", { agent_id: "a1" }), {});
  fs.unlinkSync(f.data);
  assert.deepEqual(f.bash(invokeCommand("", false)), {});
  f.setup("off"); assert.deepEqual(f.bash(invokeCommand()), {});
});

test("Bash finds inline and prompt-file tasks, handles quoting, cwd and write mode", (t) => {
  const f = fixture(t, "claude");
  assert.equal(reason(f.bash(invokeCommand())), "Run router plan for task t1 first.");
  f.plan("small"); assert.deepEqual(f.bash(invokeCommand()), {});
  assert.equal(reason(f.bash(invokeCommand("--write"))), "Claude mode: Codex does not write code; use a Claude worker.");
  fs.writeFileSync(path.join(f.project, "prompt file.txt"), "TASK: t1\nSCOPE: src/*");
  assert.deepEqual(f.bash(invokeCommand(`--prompt-file "prompt file.txt" --cwd "${f.project}"`, false)), {});
  fs.writeFileSync(path.join(f.project, "brief.txt"), "TASK: unplanned");
  assert.match(reason(f.bash(invokeCommand("--prompt-file brief.txt", false))), /Run router plan for task unplanned/);
  fs.writeFileSync(path.join(f.project, "brief.txt"), "Review only");
  assert.deepEqual(f.bash(invokeCommand("--prompt-file brief.txt", false)), {});
  assert.deepEqual(f.bash("node codex-companion.mjs invoke\nTASK: t1"), {});
  assert.deepEqual(f.bash("node codex-companion.mjs invoke -m 'gpt-6-luna' --effort low\nTASK: t1"), {});
  f.result("codex:gpt-6.1-sol/low", "verify");
  assert.equal(permission(f.bash(invokeCommand())), "deny");
  assert.deepEqual(f.bash(invokeCommand("--resume-thread thread-1")), {});
  assert.equal(permission(f.bash('node codex-companion.mjs invoke --model gpt-6.1-sol --effort low "TASK: t1\nfix it"')), "deny");
  // A final TASK line before the closing quote, equals syntax, a quoted path with spaces, and the last duplicate flag.
  assert.equal(permission(f.bash('node "C:/a b/codex-companion.mjs" invoke --model=gpt-6.1-sol --effort=low "fix it\nTASK: t1"')), "deny");
  assert.equal(permission(f.bash('node codex-companion.mjs invoke --model gpt-6.1-sol --effort max --effort low "TASK: t1"')), "deny");
  // Text that only mentions an invoke is not an invoke.
  assert.deepEqual(f.bash("rg 'codex-companion.mjs invoke --model' docs\nTASK: t1"), {});
  f.result("codex:gpt-6.1-sol/medium", null, "unverified");
  assert.match(reason(f.bash(invokeCommand("--resume-thread thread-1"))), /already passed/);
});

test("Bash owner and cost checks, nested-agent denial and hook error behavior", (t) => {
  const f = fixture(t, "codex"); f.plan();
  f.result("codex:gpt-6-luna/max", "tool"); f.result("codex:gpt-6-luna/max", "usage");
  assert.deepEqual(f.bash(invokeCommand()), {});
  f.result("codex:gpt-6-luna/max", "context");
  assert.match(reason(f.bash(invokeCommand())), /Task t1 has 3 failed attempts/);
  assert.match(reason(f.bash(invokeCommand().replace("'low'", "max"))), /Approve codex:gpt-6.1-sol\/max/);
  f.write("sessions/s1.json", { bindings: { a1: { type: "router:haiku-low", task: "t1" } } });
  assert.equal(reason(f.bash(invokeCommand("", false), { agent_id: "a1" })), "Router workers cannot start other agents.");
  fs.mkdirSync(path.join(f.project, "bad.txt"));
  const cmd = invokeCommand("--prompt-file bad.txt", false);
  assert.deepEqual(f.bash(cmd, { agent_id: "unbound" }), {});
  assert.deepEqual(f.bash(cmd), {});
});

test("Claude relaunch waits for a result from a started worker", (t) => {
  const f = fixture(t); f.plan();
  assert.deepEqual(f.agent(), {}); assert.deepEqual(f.agent(), {});
  f.hook(undefined, undefined, { agent_id: "a1", agent_type: "router:haiku-low" }, "SubagentStart");
  const message = "Record the result of the previous attempt on task t1 (router:haiku-low) with router result first.";
  assert.equal(reason(f.agent("router:sonnet-low")), message);
  f.hook(undefined, undefined, { agent_id: "a1" }, "SubagentStop");
  f.result("orchestrator", "tool");
  assert.equal(reason(f.agent("router:sonnet-low")), message);
  f.result("router:haiku-low", "tool", "fail", ["--agent", "a1"]);
  assert.deepEqual(f.agent("router:sonnet-low"), {});
  assert.deepEqual(f.hook("SendMessage", { to: "a1" }), {});
});

test("Codex completions record TASK invokes and gate fresh and resumed launches", (t) => {
  const f = fixture(t, "codex"); f.plan("small", ["--codex", codex]);
  const post = (command) => f.hook("Bash", { command }, {}, "PostToolUse");
  assert.deepEqual(post(invokeCommand("", false)), {});
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  assert.deepEqual(f.bash(invokeCommand()), {});
  assert.deepEqual(post(invokeCommand()), {});
  const launches = () => JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8")).codexLaunches;
  assert.deepEqual(launches().map(({ task, worker }) => ({ task, worker })), [{ task: "t1", worker: "codex:gpt-6.1-sol/low" }]);
  assert.equal(typeof launches()[0].time, "number");
  for (const flags of ["", "--resume-thread thread-1"]) assert.equal(reason(f.bash(invokeCommand(flags))), "Record the result of the previous attempt on task t1 (codex:gpt-6.1-sol/low) with router result first.");
  f.result("codex:gpt-6.1-sol/low", "tool");
  assert.deepEqual(f.bash(invokeCommand("--resume-thread thread-1")), {});
  fs.writeFileSync(path.join(f.project, "brief.txt"), "TASK: t1");
  assert.deepEqual(post(invokeCommand("--resume-thread thread-1 --prompt-file brief.txt", false)), {});
  assert.equal(permission(f.bash(invokeCommand("--resume-thread thread-1"))), "deny");
  assert.equal(launches().length, 2);
  f.setup("off"); post(invokeCommand()); assert.equal(launches().length, 2);
});

test("unrelated Bash completion bypasses broken storage and the lock", (t) => {
  const f = fixture(t); fs.writeFileSync(f.data, "broken");
  for (const command of ["node other.mjs", "node codex-companion.mjs invoke-status\nTASK: t1", invokeCommand("", false)]) assert.deepEqual(f.hook("Bash", { command }, {}, "PostToolUse"), {});
  fs.unlinkSync(f.data); f.write("sessions/s1.json", {});
  fs.mkdirSync(path.join(f.data, "state.lock"));
  assert.deepEqual(f.hook("Bash", { command: "git status" }, {}, "PostToolUse"), {});
});

test("failed Bash invokes record launches and enforce the same relaunch gate", (t) => {
  const f = fixture(t, "codex"); f.plan();
  const failure = (command) => f.hook("Bash", { command }, {}, "PostToolUseFailure");
  assert.deepEqual(failure(invokeCommand("", false)), {});
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  assert.deepEqual(failure(invokeCommand()), {});
  const launches = JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8")).codexLaunches;
  assert.equal(launches.length, 1); assert.equal(launches[0].task, "t1");
  assert.equal(launches[0].worker, "codex:gpt-6.1-sol/low"); assert.equal(typeof launches[0].time, "number");
  assert.match(reason(f.bash(invokeCommand("--resume-thread thread-1"))), /Record the result of the previous attempt/);
  f.result("codex:gpt-6.1-sol/low", "tool");
  assert.deepEqual(f.bash(invokeCommand("--resume-thread thread-1")), {});
  f.setup("off"); failure(invokeCommand());
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8")).codexLaunches.length, 1);
  fs.unlinkSync(path.join(f.data, "sessions/s1.json"));
  fs.rmSync(f.data, { recursive: true, force: true }); fs.writeFileSync(f.data, "broken");
  assert.deepEqual(failure("git status"), {});
});

test("only a result at or after the latest launch permits another attempt", (t) => {
  const f = fixture(t, "codex"); f.plan();
  const now = Date.now(), worker = "codex:gpt-6.1-sol/low";
  const result = { type: "result", sessionId: "s1", task: "t1", worker, outcome: "fail", reason: "tool" };
  appendResult(f.file, { ...result, time: new Date(now - 5000).toISOString() });
  // A SendMessage repair produces another result without creating a launch.
  appendResult(f.file, { ...result, outcome: "blocked", time: new Date(now - 3000).toISOString() });
  f.write("sessions/s1.json", { bindings: { old: { type: "router:haiku-low", task: "t1" } },
    codexLaunches: [{ task: "t1", worker, time: now - 1000 }] });
  for (const r of [{ ...result, worker: "orchestrator" }, { ...result, task: "t2" }, { ...result, sessionId: "s2" }]) appendResult(f.file, { ...r, time: new Date(now).toISOString() });
  const message = "Record the result of the previous attempt on task t1 (codex:gpt-6.1-sol/low) with router result first.";
  assert.equal(reason(f.bash(invokeCommand())), message);
  assert.equal(reason(f.bash(invokeCommand("--resume-thread thread-1"))), message);
  f.result(worker, "tool"); assert.deepEqual(f.bash(invokeCommand()), {});
  // Equality qualifies, and a newer Claude binding wins over older Codex launches.
  f.write("sessions/s1.json", { bindings: { latest: { type: "router:sonnet-low", task: "t1", time: now + 86400000 } }, codexLaunches: [{ task: "t1", worker, time: now - 1000 }] });
  assert.match(reason(f.bash(invokeCommand())), /task t1 \(router:sonnet-low\)/);
  appendResult(f.file, { ...result, outcome: "blocked", time: new Date(now + 86400000).toISOString() });
  assert.deepEqual(f.bash(invokeCommand()), {});
});

test("invoke detection requires an executed command boundary", (t) => {
  const f = fixture(t, "codex");
  const mention = 'echo "node codex-companion.mjs invoke --model gpt-6.1-sol --effort low"\nTASK: t1';
  for (const command of [mention, "rg 'codex-companion.mjs invoke'\nTASK: t1", "rg 'node codex-companion.mjs invoke'\nTASK: t1"]) {
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) assert.deepEqual(f.hook("Bash", { command }, {}, event), {});
  }
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  assert.equal(fs.existsSync(f.file), false);
  for (const prefix of ["", "  ", "echo ready\n ", "echo ready; ", "true && ", "false || ", "echo ready | ", "( "]) {
    assert.equal(reason(f.bash(prefix + invokeCommand())), "Run router plan for task t1 first.");
  }
});

test("unreadable invoke prompt files return no task and record nothing", (t) => {
  const f = fixture(t, "codex");
  fs.mkdirSync(path.join(f.project, "directory.txt"));
  for (const file of ["missing.txt", "directory.txt"]) {
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) assert.deepEqual(f.hook("Bash", { command: invokeCommand(`--prompt-file ${file}`, false) }, {}, event), {});
  }
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(path.join(f.data, "router.log")), false);
});

test("failure prints the stored plan view without a new plan; pass stays one line", (t) => {
  const f = fixture(t, "codex");
  assert.equal(f.result("codex:gpt-6-luna/max", "tool"), "Result: recorded t1 codex:gpt-6-luna/max fail\n");
  f.plan("small", ["--codex", "gpt-6.1-sol:low,medium"]);
  const out = f.result("codex:gpt-6-luna/max", "tool");
  assert.match(out, /^Result: recorded t1 codex:gpt-6-luna\/max fail\nPlan t1: implement, small/);
  assert.match(out, /Failed: .*Next after tool:/s);
  assert.match(out, /Candidates \(cheapest first\):\n  codex:gpt-6.1-sol\/low/);
  assert.doesNotMatch(out, /Codex workers not listed/);
  assert.match(out, /Brief lines: TASK: t1/);
  assert.match(f.result("codex:gpt-6-luna/max", "tool"), /Owner check: ask the owner before attempt 4/);
  assert.equal(readResults(f.file).filter((r) => r.type === "plan").length, 1);
  assert.equal(taskState(readResults(f.file), "s1", "t1").plan.codex, "gpt-6.1-sol:low,medium");
  assert.equal(f.result("codex:gpt-6.1-sol/low", null, "pass"), "Result: recorded t1 codex:gpt-6.1-sol/low pass\n");
});

test("SendMessage marks bound workers resumed for every decision and asks at three failures", (t) => {
  const f = fixture(t); f.plan();
  f.write("sessions/s1.json", { bindings: { a1: { type: "router:haiku-low", task: "t1" }, a2: { type: "router:haiku-low" } } });
  const send = (to = "a1") => f.hook("SendMessage", { to });
  assert.deepEqual(send(), {});
  f.result(); f.result(); assert.deepEqual(send(), {});
  f.result();
  // Writing hooks acquire and release the state lock, including stale-lock recovery.
  const lock = path.join(f.data, "state.lock"); fs.mkdirSync(lock);
  const stale = new Date(Date.now() - 61000); fs.utimesSync(lock, stale, stale);
  assert.equal(reason(send()), "Task t1 has 3 failed attempts; continue by resuming router:haiku-low?");
  assert.equal(fs.existsSync(lock), false);
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8")).bindings.a1.resumedAt, "number");
  assert.deepEqual(send("a2"), {}); assert.deepEqual(send("unbound"), {});
  appendResult(f.file, { ...readResults(f.file).at(-1), outcome: "pass" });
  assert.deepEqual(send(), {});
  const state = JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8"));
  assert.equal(typeof state.bindings.a1.resumedAt, "number");
  assert.equal(typeof state.bindings.a2.resumedAt, "number");
  assert.equal(state.bindings.unbound, undefined);
  state.bindings.a1.appliedAt = 1;
  f.write("sessions/s1.json", state);
  f.setup("off"); assert.deepEqual(send(), {});
  const resumed = JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8")).bindings.a1;
  assert.equal(resumed.appliedAt, undefined); assert.ok(resumed.resumedAt >= state.bindings.a1.resumedAt);
});
