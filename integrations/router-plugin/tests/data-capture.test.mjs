// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planRecord, resultRecord, parseSelfReport, readResults, appendResult, taskState, aggregateStats, orchestratorEdits, speedComparisons } from "../scripts/results.mjs";
import { sampleWorker } from "../scripts/router.mjs";
import { workerTable, defaultAllowed } from "../scripts/workers.mjs";

const script = fileURLToPath(new URL("../scripts/router.mjs", import.meta.url));
const calculator = fileURLToPath(new URL("../../../scripts/router-ladder-calc.mjs", import.meta.url));
const codex = "gpt-6.1-sol:low;gpt-6-luna:low,medium,high,xhigh,max";
const planArgs = ["s1", "project", "--task", "t1", "--kind", "implement", "--difficulty", "small"];
const resultArgs = ["s1", "project", "--task", "t1", "--difficulty", "small", "--worker", "router:haiku-low", "--outcome", "pass"];
const normalize = (value) => value;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-capture-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project"), data = path.join(home, ".gswitchtool-router"), file = path.join(data, "results.jsonl");
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSWITCH_ROUTER_SAMPLE_ROLL: "0" };
  function setup(router = {}) {
    const directory = path.join(home, ".gswitchtool"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "claude-setup.json"), JSON.stringify({ version: 1, setup: "router", router: { mode: "mixed", claudeOnlyReview: "on", ...router } }));
  }
  setup();
  const invoke = (args, input = "", entry = script) => spawnSync(process.execPath, [entry, ...args], { cwd: home, env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", windowsHide: true });
  const run = (args, input, entry) => { const r = invoke(args, input, entry); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const plan = (flags = [], task = "t1", kind = "implement", difficulty = "small") => run(["plan", "s1", project, "--task", task, "--kind", kind, "--difficulty", difficulty, "--codex", codex, ...flags]);
  const result = (worker, flags = [], outcome = "fail") => run(["result", "s1", project, "--task", "t1", "--difficulty", "small", "--worker", worker, "--outcome", outcome, ...(outcome === "fail" ? ["--reason", "verify"] : []), ...flags]);
  const hook = (event, extra) => JSON.parse(run(["hook", event], { session_id: "s1", cwd: project, ...extra }));
  const git = (args, cwd = project) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  return { home, project, data, file, env, setup, invoke, run, plan, result, hook, git };
}

test("plan details and result reviews validate ranges and choices, defaulting to null", () => {
  const p = planRecord(planArgs, normalize), r = resultRecord(resultArgs, normalize);
  for (const key of ["files", "crossModule", "check", "repro", "confidence"]) assert.equal(p[key], null);
  assert.equal(r.review, null); assert.equal(r.findings, null);
  const full = planRecord([...planArgs, "--files", "999", "--cross-module", "yes", "--check", "test", "--repro", "no", "--confidence", "high"], normalize);
  assert.equal(full.files, 999); assert.equal(full.crossModule, true); assert.equal(full.check, "test"); assert.equal(full.repro, false); assert.equal(full.confidence, "high");
  assert.equal(planRecord([...planArgs, "--files", "1", "--cross-module", "no", "--repro", "yes"], normalize).crossModule, false);
  for (const check of ["test", "build", "review", "none"]) assert.equal(planRecord([...planArgs, "--check", check], normalize).check, check);
  for (const confidence of ["high", "medium", "low"]) assert.equal(planRecord([...planArgs, "--confidence", confidence], normalize).confidence, confidence);
  for (const [flag, values] of [["--files", ["0", "1000", "1.5", "-1", "x"]], ["--cross-module", ["true", "YES"]], ["--check", ["tests"]], ["--repro", ["false"]], ["--confidence", ["certain"]]]) {
    for (const value of values) assert.throws(() => planRecord([...planArgs, flag, value], normalize), /Invalid|requires/);
  }
  for (const review of ["none", "minor", "serious"]) for (const findings of ["0", "99"]) {
    const value = resultRecord([...resultArgs, "--review", review, "--findings", findings], normalize);
    assert.equal(value.review, review); assert.equal(value.findings, Number(findings));
  }
  for (const [flag, value] of [["--review", "bad"], ["--findings", "100"], ["--findings", "-1"], ["--findings", "1.5"]]) assert.throws(() => resultRecord([...resultArgs, flag, value], normalize));
});

test("sample eligibility, cheapest/unknown ties, whole-log counts and preserved decisions", () => {
  const p = planRecord(planArgs, normalize);
  const rows = workerTable({ mode: "mixed", claudeAllowed: defaultAllowed(), codexAllowed: { "gpt-6.1-sol": ["low"], "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"] } });
  const pick = (records = [], plan = p, options = {}) => sampleWorker(records, plan, rows, { roll: 0, ...options });
  assert.equal(pick(), "codex:gpt-6-luna/high");
  assert.equal(pick([], { ...p, difficulty: "trivial" }), "codex:gpt-6-luna/high");
  assert.equal(pick([], p, { roll: 0.1 }), null); assert.equal(pick([], p, { roll: 1 }), null);
  assert.equal(pick([], p, { sampling: "off" }), null);
  for (const difficulty of ["moderate", "hard", "high-risk"]) assert.equal(pick([], { ...p, difficulty }), null);
  for (const kind of ["debug", "architecture"]) assert.equal(pick([], { ...p, kind }), null);
  for (const worker of ["router:haiku-low", "orchestrator"]) assert.equal(pick([{ type: "result", sessionId: "s1", task: "t1", worker }]), null);
  assert.equal(pick([{ ...p, sample: null }]), null);
  assert.equal(pick([{ ...p, sample: "router:haiku-low" }]), "router:haiku-low");
  assert.equal(pick([{ ...p, sample: "router:haiku-low" }], p, { sampling: "off", roll: 1 }), null);
  assert.equal(pick([p]), null); // Old plans never re-roll either.
  const used = rows.filter((r) => r.basis === "none").map((r) => ({ type: "result", sessionId: "other", task: "other", worker: r.worker, difficulty: "small" }));
  assert.equal(pick(used), "router:haiku-low");
  assert.equal(pick(used.map((r) => ({ ...r, difficulty: "hard" }))), "codex:gpt-6-luna/high");
  assert.equal(pick(used.map((r) => ({ ...r, type: "finish" }))), "codex:gpt-6-luna/high");
  assert.equal(sampleWorker([], p, rows.filter((r) => r.worker === "codex:gpt-6.1-sol/low"), { roll: 0 }), null);
  const costly = rows.map((r) => r.worker === "router:haiku-low" ? { ...r, cost: 0.5 } : { ...r, approval: true });
  assert.equal(sampleWorker([], p, costly, { roll: 0 }), null);
  const unknown = rows.filter((r) => r.worker === "codex:gpt-6.1-sol/low" || r.basis === "none");
  assert.equal(sampleWorker([], p, unknown, { roll: 0 }), "codex:gpt-6-luna/high");
});

test("plan sample line preserves candidates, marks only first result, and does not raise floor", (t) => {
  const f = fixture(t);
  const output = f.plan(), sample = readResults(f.file)[0].sample;
  assert.ok(output.includes('Sample attempt (about 1 in 10 trivial/small tasks): ' + sample + ' — start with it to measure it; if it fails, use the candidates below. Say "sample attempt" in the report.'));
  assert.ok(output.indexOf("Sample attempt") < output.indexOf("Candidates"));
  const candidates = output.slice(output.indexOf("Candidates"));
  f.setup({ sampling: "off" });
  assert.doesNotMatch(f.plan([], "other"), /Sample attempt/);
  const normal = f.plan([], "normal");
  assert.equal(normal.slice(normal.indexOf("Candidates")).split("Brief lines:")[0], candidates.split("Brief lines:")[0]);
  f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "1";
  assert.equal(readResults(f.file).at(-1).sample, null);
  f.setup(); f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "0";
  assert.ok(f.plan([], "setting-off").includes("Sample attempt"));
  f.setup({ sampling: "off" });
  const offReplan = f.plan([], "setting-off");
  assert.doesNotMatch(offReplan, /Sample attempt/);
  assert.equal(readResults(f.file).at(-1).sample, null);
  f.setup(); f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "1";
  assert.ok(f.plan().includes("Sample attempt")); // Eligible re-plan keeps the existing sample when the roll changes.
  const command = 'node "codex-companion.mjs" invoke --model gpt-6-luna --effort high\nTASK: t1';
  assert.deepEqual(f.hook("PreToolUse", { tool_name: "Bash", tool_input: { command } }), {});
  const failed = f.result(sample);
  assert.match(failed, /floor 0 \(small\)/); assert.doesNotMatch(failed, /Sample attempt/);
  assert.match(failed, /Next after a failed sample attempt: use the candidates below; do not repair the sample worker\./);
  assert.doesNotMatch(failed, /Next after verify:/);
  assert.equal(readResults(f.file).at(-1).sample, true);
  assert.equal(taskState(readResults(f.file), "s1", "t1").failedWorkers[0].sample, true);
  assert.equal(f.hook("PreToolUse", { tool_name: "Bash", tool_input: { command } }).hookSpecificOutput.permissionDecision, "deny");
  f.result(sample);
  assert.equal(readResults(f.file).at(-1).sample, false);
  assert.match(f.plan(), /floor 42 \(moderate\)/);
  f.result("router:haiku-low", [], "fail");
  assert.match(f.plan(), /Owner check: ask the owner before attempt 4/);
});

test("sampling setting, modes, kinds, results and roll boundaries at the command boundary", (t) => {
  const f = fixture(t);
  for (const setting of [undefined, "invalid", null, "on"]) {
    f.setup({ sampling: setting }); f.plan([], String(setting));
    assert.ok(readResults(f.file).at(-1).sample);
  }
  f.setup({ sampling: "off" }); f.plan(); assert.equal(readResults(f.file).at(-1).sample, null);
  f.setup();
  f.plan([], "replan-hard"); assert.ok(readResults(f.file).at(-1).sample);
  f.plan([], "replan-hard", "implement", "hard"); assert.equal(readResults(f.file).at(-1).sample, null);
  f.plan([], "replan-debug"); assert.ok(readResults(f.file).at(-1).sample);
  f.plan([], "replan-debug", "debug", "small"); assert.equal(readResults(f.file).at(-1).sample, null);
  f.plan([], "replan-eligible");
  const eligibleSample = readResults(f.file).at(-1).sample; assert.ok(eligibleSample);
  f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "1";
  f.plan([], "replan-eligible"); assert.equal(readResults(f.file).at(-1).sample, eligibleSample);
  f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "0";
  for (const kind of ["debug", "architecture"]) { f.plan([], kind, kind); assert.equal(readResults(f.file).at(-1).sample, null); }
  f.plan([], "moderate", "implement", "moderate"); assert.equal(readResults(f.file).at(-1).sample, null);
  appendResult(f.file, { type: "result", sessionId: "s1", task: "used", worker: "router:haiku-low", outcome: "fail" });
  f.plan([], "used"); assert.equal(readResults(f.file).at(-1).sample, null);
  f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "0.1"; f.plan([], "boundary"); assert.equal(readResults(f.file).at(-1).sample, null);
  f.env.GSWITCH_ROUTER_SAMPLE_ROLL = "0"; f.plan([], "boundary"); assert.equal(readResults(f.file).at(-1).sample, null);
  f.setup({ mode: "claude", prefer: "price" }); f.plan([], "empty"); assert.equal(readResults(f.file).at(-1).sample, null);
  f.setup({ mode: "codex" }); f.plan([], "codex"); assert.ok(readResults(f.file).at(-1).sample?.startsWith("codex:"));
  f.setup({ mode: "claude", claudeAllowed: { sonnet: ["low"], haiku: ["medium"] }, prefer: "claude" });
  // Cheapest Claude is already the first candidate; there is no cheaper sample.
  f.plan([], "claude"); assert.equal(readResults(f.file).at(-1).sample, null);
});

test("close captures hindsight, works when off, appends repeated closures and rejects invalid input", (t) => {
  const f = fixture(t);
  const args = ["close", "s1", f.project, "--task", "t1", "--actual", "moderate", "--orchestrator-fix", "yes"];
  assert.equal(f.invoke(args).status, 1);
  f.plan();
  assert.equal(f.run(args).trim(), "Closed t1: planned small, actual moderate, 0 attempts, not passed");
  f.result("orchestrator", [], "pass"); f.result("router:haiku-low", [], "pass");
  f.setup({ mode: "off" });
  assert.equal(f.run([...args, "--note", "fixed it"]).trim(), "Closed t1: planned small, actual moderate, 1 attempts, passed");
  const closes = readResults(f.file).filter((r) => r.type === "close");
  assert.equal(closes.length, 2); assert.equal(closes[0].note, null);
  assert.deepEqual({ ...closes[1], time: null, project: null }, { type: "close", time: null, sessionId: "s1", project: null, task: "t1", planned: "small", actual: "moderate", orchestratorFix: true, attempts: 1, passed: true, note: "fixed it" });
  for (const flags of [["--note", "x".repeat(121)], ["--actual", "bad"], ["--orchestrator-fix", "maybe"]]) assert.equal(f.invoke([...args, ...flags]).status, 1);
  assert.equal(f.invoke(["close", "s1", f.project, "--task", "t1"]).status, 1);
});

test("self report reads the last RESULT line with reordered keys and independent invalid parts", () => {
  assert.equal(parseSelfReport("no report"), null); assert.equal(parseSelfReport(null), null);
  for (const separator of ["·", "|", ";", ","]) {
    const line = ["RESULT: done", "felt: hard", "verify-fails: 2", "confidence: high"].join(" " + separator + " ");
    assert.deepEqual(parseSelfReport("RESULT: stopped\n" + line + "\n"), { status: "done", confidence: "high", felt: "hard", verifyFails: 2 });
  }
  assert.deepEqual(parseSelfReport("RESULT: partial"), { status: "partial", confidence: null, felt: null, verifyFails: null });
  assert.deepEqual(parseSelfReport("RESULT: bad | confidence: low | felt: tiny | verify-fails: -1"), { status: null, confidence: "low", felt: null, verifyFails: null });
  assert.deepEqual(parseSelfReport("RESULT: stopped; felt: high-risk; confidence: bad; verify-fails: 1.5"), { status: "stopped", confidence: null, felt: "high-risk", verifyFails: null });
  assert.deepEqual(parseSelfReport("RESULT: done | verify-fails: 0"), { status: "done", confidence: null, felt: null, verifyFails: 0 });
});

test("SubagentStop stores direct or transcript self report, and tolerates unreadable transcripts", (t) => {
  const f = fixture(t), transcript = path.join(f.home, "transcript.jsonl");
  fs.mkdirSync(path.join(f.data, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(f.data, "sessions/s1.json"), JSON.stringify({ bindings: { a1: { type: "router:haiku-low", task: "t1" } } }));
  const report = "RESULT: done · confidence: high · felt: small · verify-fails: 0";
  fs.writeFileSync(transcript, ['{bad}', JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "RESULT: partial" }] } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", text: "RESULT: stopped" }, { type: "text", text: "Changed files" }, { type: "text", text: report }] } })].join("\n"));
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: transcript, last_assistant_message: "RESULT: stopped | confidence: low" });
  assert.equal(readResults(f.file).at(-1).self.status, "stopped");
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: transcript, last_assistant_message: {} });
  assert.deepEqual(readResults(f.file).at(-1).self, parseSelfReport(report));
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: "missing" }); assert.equal(readResults(f.file).at(-1).self, null);
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: transcript, last_assistant_message: "" }); assert.equal(readResults(f.file).at(-1).self, null);
});

test("finish records real git size, verification and scope facts once per checked run", (t) => {
  const f = fixture(t);
  f.run(["plan", "s1", f.project, "--task", "t1", "--kind", "implement", "--difficulty", "small", "--codex", "gpt-6.1-sol:low"]);
  f.git(["init", "-b", "main"]); f.git(["config", "user.name", "Router Test"]); f.git(["config", "user.email", "router@example.invalid"]); f.git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(f.project, "file.txt"), "base\n"); f.git(["add", "."]); f.git(["commit", "-m", "base"]);
  const worktree = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worktree]);
  fs.mkdirSync(path.join(f.data, "sessions"), { recursive: true });
  const sessionFile = path.join(f.data, "sessions/s1.json");
  const bound = { type: "router:haiku-low", task: "t1", cwd: worktree, scope: ["file.txt"] };
  fs.writeFileSync(sessionFile, JSON.stringify({ bindings: { a1: bound } }));
  const args = ["finish", "s1", f.project, "--agent", "a1"];
  assert.match(f.run(args), /Worker still running/); assert.equal(readResults(f.file).filter((r) => r.type === "finish").length, 0);
  fs.writeFileSync(sessionFile, JSON.stringify({ bindings: { a1: { ...bound, cwd: f.project } }, finished: [{ agentId: "a1", time: Date.now() }] }));
  assert.match(f.run(args), /no worktree/); assert.equal(readResults(f.file).filter((r) => r.type === "finish").length, 0);
  fs.writeFileSync(sessionFile, JSON.stringify({ bindings: { a1: bound }, finished: [{ agentId: "a1", time: Date.now() }] }));
  fs.writeFileSync(path.join(worktree, "file.txt"), "changed\nsecond\n");
  const failed = f.run([...args, "--verify", 'node -e "process.exit(1)"']);
  assert.match(failed, /Verify: FAILED/); assert.match(failed, /floor 0 \(small\)/);
  assert.equal(readResults(f.file).find((r) => r.type === "result").sample, true);
  let record = readResults(f.file).at(-1);
  assert.deepEqual({ ...record, time: null, project: null }, { type: "finish", time: null, sessionId: "s1", project: null, task: "t1", worker: "router:haiku-low", agentId: "a1", files: 1, added: 2, deleted: 1, verify: "failed", scopeWarnings: 0, applied: false });
  fs.writeFileSync(path.join(worktree, "outside.txt"), "extra\n");
  assert.match(f.run(args), /Not applied: decide/); record = readResults(f.file).at(-1);
  assert.equal(record.scopeWarnings, 1); assert.equal(record.verify, "none"); assert.equal(record.applied, false);
  fs.unlinkSync(path.join(worktree, "outside.txt"));
  assert.match(f.run([...args, "--verify", 'node -e "process.exit(0)"']), /Applied\./);
  record = readResults(f.file).at(-1); assert.equal(record.applied, true); assert.equal(record.verify, "passed");
  const count = readResults(f.file).filter((r) => r.type === "finish").length;
  assert.equal(f.run(args), "Already applied.\n"); assert.equal(readResults(f.file).filter((r) => r.type === "finish").length, count);
});

test("old log stats, ladder and task state ignore finish/close and added telemetry fields", (t) => {
  const f = fixture(t), time = new Date().toISOString();
  f.plan();
  for (let i = 0; i < 10; i++) appendResult(f.file, { type: "result", time, sessionId: "s1", project: f.project, task: "t1", difficulty: "small", worker: "router:haiku-low", outcome: "pass" });
  const old = readResults(f.file), stats = f.run(["stats"]), ladder = f.run(["--results", f.file], "", calculator), state = taskState(old, "s1", "t1");
  const enriched = old.map((r) => ({ ...r, review: "none", findings: 0, self: { felt: "hard" }, files: 1 }));
  fs.writeFileSync(f.file, enriched.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const type of ["finish", "close"]) appendResult(f.file, { ...old.at(-1), type, added: 100, passed: false });
  const records = readResults(f.file);
  assert.equal(f.run(["stats"]), stats); assert.equal(f.run(["--results", f.file], "", calculator), ladder);
  assert.deepEqual(aggregateStats(records), aggregateStats(old)); assert.equal(orchestratorEdits(records), orchestratorEdits(old)); assert.deepEqual(speedComparisons(records), speedComparisons(old));
  const current = taskState(records, "s1", "t1");
  assert.equal(current.failures, state.failures); assert.equal(current.done, state.done); assert.equal(current.results.length, state.results.length); assert.deepEqual(current.failedWorkers, state.failedWorkers);
});
