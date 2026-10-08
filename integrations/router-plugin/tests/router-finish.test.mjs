// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readResults } from "../scripts/results.mjs";

const script = fileURLToPath(new URL("../scripts/router.mjs", import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-finish-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project"), worker = path.join(home, "worker"), data = path.join(home, ".gswitchtool-router");
  fs.mkdirSync(project); fs.mkdirSync(path.join(home, ".gswitchtool"));
  fs.writeFileSync(path.join(home, ".gswitchtool/claude-setup.json"), JSON.stringify({ version: 1, setup: "router", router: { mode: "mixed", claudeOnlyReview: "on" } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const invoke = (args) => spawnSync(process.execPath, [script, ...args], { cwd: project, env, encoding: "utf8", windowsHide: true });
  const run = (args) => { const r = invoke(args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const git = (args) => { const r = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  git(["init"]); git(["config", "core.autocrlf", "false"]);
  git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]);
  fs.writeFileSync(path.join(project, "file.txt"), "base\n"); git(["add", "."]); git(["commit", "-m", "fixture"]);
  git(["worktree", "add", "-b", "worker", worker]);
  run(["plan", "s1", project, "--task", "t1", "--kind", "implement", "--difficulty", "small", "--title", "Finish fixture", "--codex", "gpt-6.1-sol:low,medium"]);
  const bind = (cwd = worker, task = "t1", agent = "a1") => {
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(data, "sessions/s1.json"), JSON.stringify({ bindings: { [agent]: { type: "router:haiku-low", task, scope: ["file.txt"], cwd } } }));
  };
  bind();
  const finish = (flags = []) => run(["finish", "s1", project, "--agent", "a1", ...flags]);
  const results = () => readResults(path.join(data, "results.jsonl")).filter((r) => r.type === "result");
  return { home, project, worker, data, invoke, run, bind, finish, results };
}
const verify = (exit) => ["--verify", `"${process.execPath}" -e "process.exit(${exit})"`];

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
