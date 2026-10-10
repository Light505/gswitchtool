// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readResults, validResult, aggregateStats } from "../scripts/results.mjs";
import { worktreeApplied } from "../scripts/router.mjs";

const script = fileURLToPath(new URL("../scripts/router.mjs", import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-finish-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project"), worker = path.join(home, "worker"), data = path.join(home, ".gswitchtool-router");
  fs.mkdirSync(project); fs.mkdirSync(path.join(home, ".gswitchtool"));
  fs.writeFileSync(path.join(home, ".gswitchtool/claude-setup.json"), JSON.stringify({ version: 1, setup: "router", router: { mode: "mixed", claudeOnlyReview: "on" } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSWITCH_ROUTER_SAMPLE_ROLL: "1" };
  const invoke = (args, input) => spawnSync(process.execPath, [script, ...args], { cwd: project, env, input, encoding: "utf8", windowsHide: true });
  const run = (args, input) => { const r = invoke(args, input); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const hook = (event, extra) => JSON.parse(run(["hook", event], JSON.stringify({ session_id: "s1", cwd: project, ...extra })));
  // These tests cover the manual router finish fallback: a stop with stop_hook_active records the stop without the hook's own check.
  const stop = (agent = "a1") => hook("SubagentStop", { agent_id: agent, stop_hook_active: true });
  const resume = (agent = "a1") => hook("PreToolUse", { tool_name: "SendMessage", tool_input: { to: agent } });
  const state = () => JSON.parse(fs.readFileSync(path.join(data, "sessions/s1.json"), "utf8"));
  const git = (args) => { const r = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  git(["init"]); git(["config", "core.autocrlf", "false"]);
  git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]);
  fs.writeFileSync(path.join(project, "file.txt"), "base\n"); git(["add", "."]); git(["commit", "-m", "fixture"]);
  git(["worktree", "add", "-b", "worker", worker]);
  run(["plan", "s1", project, "--task", "t1", "--kind", "implement", "--difficulty", "small", "--title", "Finish fixture", "--codex", "gpt-6.1-sol:low,medium"]);
  const bind = (cwd = worker, task = "t1", agent = "a1", stopped = true, extra = {}) => {
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(data, "sessions/s1.json"), JSON.stringify({ bindings: { [agent]: { type: "router:haiku-low", task, scope: ["file.txt"], cwd, ...extra } } }));
    if (stopped) stop(agent);
  };
  bind();
  const finish = (flags = []) => run(["finish", "s1", project, "--agent", "a1", ...flags]);
  const results = () => readResults(path.join(data, "results.jsonl")).filter((r) => r.type === "result");
  // A worker's own stop: the hook checks, applies, records and blocks once.
  const check = (message = "Changed file.txt\nRESULT: done · confidence: high · felt: small · verify-fails: 0", agent = "a1") =>
    hook("SubagentStop", { agent_id: agent, last_assistant_message: message });
  return { home, project, worker, data, invoke, run, git, bind, finish, results, stop, resume, state, hook, check };
}
const verify = (exit) => ["--verify", `"${process.execPath}" -e "process.exit(${exit})"`];
const waitMessage = "Worker still running or not stopped: wait for its completion notice, then run router finish again. If it has stopped and this repeats, apply it with router apply.\n";

test("finish verify failures record start and repair with plan metadata and keep the worktree", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  for (const step of ["start", "repair"]) {
    const out = f.finish(verify(1));
    assert.match(out, /Verify: FAILED/); assert.match(out, /Result: recorded t1 router:haiku-low fail\nPlan t1/);
    assert.match(out, /codex:gpt-6.1-sol\/low/);
    const r = f.results().at(-1);
    assert.equal(r.reason, "verify"); assert.equal(r.step, step); assert.equal(r.agentId, "a1");
    assert.equal(r.difficulty, "small"); assert.equal(r.title, "Finish fixture");
    assert.equal(fs.readFileSync(path.join(f.worker, "file.txt"), "utf8"), "worker\n");
    assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  }
});

test("finish records escalation after a different worker result", (t) => {
  const f = fixture(t);
  f.run(["result", "s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "router:sonnet-low", "--outcome", "fail", "--reason", "tool", "--agent", "a2"]);
  f.finish(verify(1)); assert.equal(f.results().at(-1).step, "escalation");
});

test("finish applies verified in-scope changes and records nothing", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  const out = f.finish(verify(0));
  assert.match(out, /Verify: passed/); assert.match(out, /Applied\. Review it, then record pass \(or a review failure\) with router result\./);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "worker\n");
  assert.equal(fs.existsSync(f.worker), false); assert.deepEqual(f.results(), []);
  assert.equal(f.finish(verify(1)), "Already applied.\n");
});

test("finish applies a stopped worker's locked worktree and keeps it without a failure", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  f.bind(f.worker, "t1", "a1", true);
  f.git(["worktree", "lock", "--reason", "claude agent agent-a1 (pid 123)", f.worker]);
  const out = f.finish(verify(0));
  assert.match(out, /Verify: passed/); assert.match(out, /Worktree: applied 1 files/);
  assert.ok(out.includes(`Worktree kept: ${f.worker} — locked by Claude Code; remove it after this session\nApplied. Review it, then record pass`));
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "worker\n");
  assert.equal(fs.existsSync(f.worker), true); assert.deepEqual(f.results(), []);
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: f.project, encoding: "utf8", windowsHide: true });
  assert.equal(listed.status, 0, listed.stderr); assert.match(listed.stdout, /locked claude agent agent-a1/);
  // A second apply would overwrite this owner edit or record a conflict.
  fs.writeFileSync(path.join(f.project, "file.txt"), "owner after apply\n");
  assert.equal(f.finish(verify(1)), "Already applied.\n");
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "owner after apply\n");
  assert.deepEqual(f.results(), []);
  assert.equal(typeof f.state().bindings.a1.appliedAt, "number");
  f.resume();
  assert.equal(f.state().bindings.a1.appliedAt, undefined);
  assert.equal(f.finish(verify(1)), waitMessage);
});

test("finish waits for a locked worker without a stop notice without verifying or applying", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  f.bind(f.worker, "t1", "a1", false);
  f.git(["worktree", "lock", "--reason", "claude agent agent-a1 (pid 123)", f.worker]);
  assert.equal(f.finish(verify(1)), waitMessage);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  assert.equal(fs.readFileSync(path.join(f.worker, "file.txt"), "utf8"), "worker\n");
  assert.deepEqual(f.results(), []);
});

test("finish waits for an unlocked worker without a stop record", (t) => {
  const f = fixture(t); f.bind(f.worker, "t1", "a1", false);
  fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  assert.equal(f.finish(verify(1)), waitMessage);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  assert.equal(fs.existsSync(f.worker), true); assert.deepEqual(f.results(), []);
});

for (const locked of [false, true]) test(`finish waits after resume and applies after a new stop (${locked ? "locked" : "unlocked"})`, (t) => {
  const f = fixture(t);
  if (locked) f.git(["worktree", "lock", "--reason", "claude agent agent-a1", f.worker]);
  fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  const firstStop = f.state().finished[0].time;
  f.resume();
  assert.ok(f.state().bindings.a1.resumedAt >= firstStop);
  assert.equal(f.finish(verify(1)), waitMessage);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  assert.deepEqual(f.results(), []);
  f.stop();
  assert.equal(f.state().finished.length, 1);
  assert.ok(f.state().finished[0].time > firstStop);
  assert.equal(f.state().bindings.a1.resumedAt, undefined);
  assert.match(f.finish(verify(0)), /Worktree: applied 1 files/);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "worker\n");
  assert.deepEqual(f.results(), []);
});

test("manual apply still refuses a locked worktree without --keep-locked", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  f.git(["worktree", "lock", "--reason", "claude agent agent-a1", f.worker]);
  const out = f.run(["apply", "--worktree", f.worker, "--cwd", f.project]);
  assert.match(out, /Worktree kept: .*worktree is locked/); assert.equal(worktreeApplied(out), false);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  assert.equal(fs.existsSync(f.worker), true);
});

test("finish retains three-way conflict safety for stopped locked workers", (t) => {
  const f = fixture(t); f.bind(f.worker, "t1", "a1", true);
  f.git(["worktree", "lock", "--reason", "claude agent agent-a1", f.worker]);
  fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n"); fs.writeFileSync(path.join(f.project, "file.txt"), "owner\n");
  assert.match(f.finish(), /Worktree kept: .*three-way apply conflict/);
  assert.equal(f.results()[0].reason, "worktree");
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "owner\n");
  assert.equal(fs.readFileSync(path.join(f.worker, "file.txt"), "utf8"), "worker\n");
});

test("finish's apply decision treats applied cleanup failures as success", () => {
  for (const reason of ["cleanup failed", "dependency-link cleanup failed"]) {
    assert.equal(worktreeApplied(`Worktree: applied 1 files\nWorktree kept: /worker — ${reason}`), true);
  }
  assert.equal(worktreeApplied("Worktree: applied 0 files"), true);
  assert.equal(worktreeApplied("Worktree kept: /worker — unsafe destination: file.txt"), false);
  assert.equal(worktreeApplied("Worktree kept: /worker — untracked destination exists: file.txt"), false);
});

test("finish out-of-scope warning neither applies nor records", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "outside.txt"), "outside\n");
  const out = f.finish(); assert.match(out, /WARNING: changed outside --scope: outside.txt/);
  assert.match(out, /Not applied: decide the out-of-scope changes/);
  assert.equal(fs.existsSync(path.join(f.project, "outside.txt")), false);
  assert.equal(fs.existsSync(f.worker), true); assert.deepEqual(f.results(), []);
});

test("finish checks committed out-of-scope changes from the merge base", (t) => {
  const f = fixture(t);
  const git = (args, cwd) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const base = git(["rev-parse", "HEAD"], f.project);
  fs.writeFileSync(path.join(f.worker, "outside.txt"), "committed\n");
  git(["add", "."], f.worker); git(["commit", "-m", "outside scope"], f.worker);
  assert.equal(git(["status", "--porcelain"], f.worker), "");
  assert.doesNotMatch(f.run(["check", "--cwd", f.worker, "--scope", "file.txt"]), /WARNING/);
  fs.writeFileSync(path.join(f.worker, "untracked.txt"), "untracked\n");
  const checked = f.run(["check", "--cwd", f.worker, "--base", base, "--scope", "file.txt"]);
  assert.match(checked, /WARNING: changed outside --scope: outside.txt/);
  assert.match(checked, /WARNING: changed outside --scope: untracked.txt/);
  fs.unlinkSync(path.join(f.worker, "untracked.txt"));
  // Main HEAD has also advanced, so the common base is neither checkout's HEAD.
  fs.writeFileSync(path.join(f.project, "owner.txt"), "owner\n");
  git(["add", "."], f.project); git(["commit", "-m", "owner change"], f.project);
  const out = f.finish();
  assert.match(out, /WARNING: changed outside --scope: outside.txt/);
  assert.match(out, /Not applied: decide the out-of-scope changes/);
  assert.equal(fs.existsSync(path.join(f.project, "outside.txt")), false);
  assert.equal(fs.existsSync(f.worker), true); assert.deepEqual(f.results(), []);
});

test("finish apply conflict records worktree failure and preserves both checkouts", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n"); fs.writeFileSync(path.join(f.project, "file.txt"), "owner\n");
  const out = f.finish(); assert.match(out, /Worktree kept: .*three-way apply conflict/);
  assert.match(out, /Next after worktree: keep the worktree/);
  assert.equal(f.results()[0].reason, "worktree"); assert.equal(f.results()[0].step, "start"); assert.equal(f.results()[0].agentId, "a1");
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "owner\n");
  assert.equal(fs.readFileSync(path.join(f.worker, "file.txt"), "utf8"), "worker\n");
});

test("finish rejects unbound or taskless workers and skips missing or main-checkout cwd", (t) => {
  const f = fixture(t);
  const unknown = f.invoke(["finish", "s1", f.project, "--agent", "unknown"]);
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /Worker unknown is not bound/);
  f.bind(f.worker, null);
  const taskless = f.invoke(["finish", "s1", f.project, "--agent", "a1"]);
  assert.equal(taskless.status, 1); assert.match(taskless.stderr, /has no task/);
  for (const cwd of [f.project, path.join(f.home, "missing"), null]) { f.bind(cwd); assert.equal(f.finish(), "Worker changed nothing (no worktree).\n"); }
  assert.deepEqual(f.results(), []);
});

test("finish does not hold the state lock while verify runs", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  const lock = path.join(f.data, "state.lock").replace(/\\/g, "/");
  const out = f.finish(["--verify", `"${process.execPath}" -e "process.exit(require('fs').existsSync('${lock}') ? 7 : 0)"`]);
  assert.match(out, /Verify: passed/); assert.match(out, /Applied\./);
});

// The block reason a worker repeats as the end of its final message; returns the ROUTER lines.
function verdict(response) {
  assert.equal(response.decision, "block");
  const [first, ...lines] = response.reason.split("\n");
  assert.equal(first, "Router check done. Do not edit files or run commands. Reply with your report from before, unchanged, and end it with these lines exactly:");
  return lines;
}
const records = (f, ...types) => readResults(path.join(f.data, "results.jsonl")).filter((r) => types.includes(r.type));

test("SubagentStop applies a verified in-scope worker, records pass, blocks once and denies edits meanwhile", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  // Verify runs outside the state lock.
  const lock = path.join(f.data, "state.lock").replace(/\\/g, "/");
  f.bind(f.worker, "t1", "a1", false, { verify: `"${process.execPath}" -e "process.exit(require('fs').existsSync('${lock}') ? 7 : 0)"` });
  const lines = verdict(f.check());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ROUTER: t1 router:haiku-low pass · applied 1 files · Verify: passed \(.+, \d+s\)$/);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "worker\n");
  const result = f.results().at(-1);
  assert.deepEqual([result.outcome, result.reason, result.step, result.agentId, result.sample, result.source, result.title, result.difficulty],
    ["pass", null, "start", "a1", false, "hook", "Finish fixture", "small"]);
  assert.equal(validResult(result), true);
  assert.equal(aggregateStats(records(f, "result", "attempt"))[0].passes, 1);
  const finished = records(f, "finish");
  assert.equal(finished.length, 1); assert.equal(finished[0].applied, true); assert.equal(finished[0].verify, "passed");
  assert.equal(f.state().bindings.a1.verdictPending, true); assert.equal(typeof f.state().bindings.a1.appliedAt, "number");
  const edit = f.hook("PreToolUse", { agent_id: "a1", tool_name: "Edit", tool_input: { file_path: "file.txt" } });
  assert.equal(edit.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(edit.hookSpecificOutput.permissionDecisionReason, "The router already checked your work; do not edit. Reply with your report and the ROUTER lines.");
  // The repeated report ends the worker: no second check and no new result or finish record.
  const count = records(f, "result", "finish").length;
  assert.deepEqual(f.check(`Report\n${lines[0]}`), {});
  assert.equal(records(f, "result", "finish").length, count);
  assert.equal(f.state().bindings.a1.verdictPending, undefined);
  assert.equal(f.finish(), "Already applied.\n");
});

test("SubagentStop records a verify failure, keeps the worktree, and checks a resumed worker again as a repair", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  f.bind(f.worker, "t1", "a1", false, { verify: `"${process.execPath}" -e "for(let i=0;i<30;i++)console.log('line'+i);process.exit(3)"` });
  const lines = verdict(f.check());
  assert.equal(lines[0], "ROUTER: t1 router:haiku-low fail (verify) · not applied · Verify: FAILED (exit 3)");
  assert.equal(lines[1], `Worktree kept: ${f.worker} — verify failed`);
  assert.deepEqual(lines.slice(2, 17), Array.from({ length: 15 }, (_, i) => `line${i + 15}`));
  assert.match(lines[17], /^Next: repair once with the same worker/);
  assert.match(lines[18], /^Candidates: codex:gpt-6\.1-sol\/low/);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  assert.equal(fs.readFileSync(path.join(f.worker, "file.txt"), "utf8"), "worker\n");
  let result = f.results().at(-1);
  assert.deepEqual([result.outcome, result.reason, result.step, result.source], ["fail", "verify", "start", "hook"]);
  assert.equal(records(f, "finish")[0].applied, false); assert.equal(records(f, "finish")[0].verify, "failed");
  f.resume();
  assert.equal(f.state().bindings.a1.verdictPending, undefined);
  assert.deepEqual(f.hook("PreToolUse", { agent_id: "a1", tool_name: "Edit", tool_input: { file_path: "file.txt" } }), {});
  assert.match(verdict(f.check())[0], /fail \(verify\)/);
  result = f.results().at(-1);
  assert.equal(result.step, "repair"); assert.equal(f.results().length, 2);
});

test("SubagentStop reads SCOPE REQUEST, STOPPED and unchanged workers without verifying or applying", (t) => {
  const f = fixture(t);
  f.bind(f.worker, "t1", "a1", false, { verify: `"${process.execPath}" -e "process.exit(1)"` });
  let lines = verdict(f.check());
  assert.deepEqual(lines.slice(0, 3), ["ROUTER: t1 router:haiku-low fail (incomplete) · not applied · Verify: none", "Worker changed nothing.", "Next: repair once with the same worker (resume it with the evidence), or escalate"]);
  fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n");
  for (const [line, reason] of [["SCOPE REQUEST: other.txt — needed — edit it", "scope"], ["- STOPPED: too hard — x", "capability"],
    ["STOPPED: unclear brief — x", "context"], ["STOPPED: environment — x", "tool"], ["STOPPED: something else", "other"]]) {
    f.resume();
    lines = verdict(f.check(`Report\n${line}\nRESULT: stopped · confidence: low · felt: hard · verify-fails: 0`));
    assert.equal(lines[0], `ROUTER: t1 router:haiku-low fail (${reason}) · not applied · Verify: none`);
    assert.deepEqual([f.results().at(-1).reason, f.results().at(-1).step], [reason, "repair"]);
  }
  assert.match(lines.join("\n"), /Owner check: ask the owner before attempt 7\./);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "base\n");
  assert.deepEqual(records(f, "finish"), []);
  // Research and review workers that change nothing are unverified, not failed.
  f.run(["plan", "s1", f.project, "--task", "r1", "--kind", "research", "--difficulty", "small"]);
  f.bind(f.project, "r1", "a2", false);
  assert.deepEqual(verdict(f.check(undefined, "a2")), ["ROUTER: r1 router:haiku-low unverified · not applied · Verify: none", "Worker changed nothing."]);
});

test("SubagentStop blocks out-of-scope changes with the scope and finish commands; router finish then applies", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.worker, "file.txt"), "worker\n"); fs.writeFileSync(path.join(f.worker, "outside.txt"), "outside\n");
  f.bind(f.worker, "t1", "a1", false);
  const lines = verdict(f.check());
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "ROUTER: t1 router:haiku-low blocked (scope) · not applied · Verify: none");
  assert.equal(lines[1], `Worktree kept: ${f.worker} — changed outside SCOPE: outside.txt`);
  const approve = lines[2].match(/^Approve: node "(.+)" scope s1 a1 --add "outside.txt"$/);
  assert.ok(approve); assert.equal(path.resolve(approve[1]), path.resolve(script));
  const directory = lines[3].match(/^Then apply: node ".+" finish s1 "(.+)" --agent a1$/)[1];
  assert.equal(fs.existsSync(path.join(f.project, "outside.txt")), false);
  assert.deepEqual([f.results().at(-1).outcome, f.results().at(-1).reason], ["blocked", "scope"]);
  assert.equal(records(f, "finish")[0].scopeWarnings, 1);
  f.run(["scope", "s1", "a1", "--add", "outside.txt"]);
  assert.match(f.run(["finish", "s1", directory, "--agent", "a1"]), /Applied\./);
  assert.equal(fs.readFileSync(path.join(f.project, "outside.txt"), "utf8"), "outside\n");
});
