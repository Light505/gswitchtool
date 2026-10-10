// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { appendResult, readResults, resultRecord, validResult, aggregateStats, orchestratorEdits, statsTable } from "../scripts/results.mjs";
import { projectKey } from "../scripts/router.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(plugin, "scripts/router.mjs");
const calculator = path.resolve(plugin, "../../scripts/router-ladder-calc.mjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-orchestrator-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const project = path.join(home, "project with spaces");
  fs.mkdirSync(project);
  const data = path.join(home, ".gswitchtool-router"), file = path.join(data, "results.jsonl");
  function invoke(args, input = "", entry = script) {
    return spawnSync(process.execPath, [entry, ...args], { cwd: home, env, input, encoding: "utf8", windowsHide: true });
  }
  function run(args, input, entry) {
    const r = invoke(args, input, entry);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
  const orchestratorArgs = (...flags) => ["result", "s1", project, "--task", "t1", "--difficulty", "small", "--worker", "orchestrator", "--outcome", "pass", ...flags];
  return { home, env, project, data, file, invoke, run, orchestratorArgs };
}

test("orchestrator results are accepted in both namespaces with the same record shape", (t) => {
  const f = fixture(t);
  assert.equal(f.run(f.orchestratorArgs()), "Result: recorded t1 orchestrator pass\n");
  const r = readResults(f.file)[0];
  assert.deepEqual(r, { type: "result", time: r.time, sessionId: "s1", project: projectKey(f.project), task: "t1", difficulty: "small",
    worker: "orchestrator", outcome: "pass", review: null, findings: null, sample: false, reason: null, step: null, title: null, agentId: null, codexJobId: null, codexThreadId: null });
  assert.equal(resultRecord(["s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "orchestrator", "--outcome", "fail", "--reason", "other"], projectKey, "router-dev").worker, "orchestrator");
  assert.equal(resultRecord(["s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "orchestrator", "--outcome", "fail", "--reason", "other"], projectKey, "router").worker, "orchestrator");
});

test("orchestrator results reject agent and Codex fields and name orchestrator as a valid worker", (t) => {
  const f = fixture(t);
  const before = fs.existsSync(f.file) ? fs.readFileSync(f.file, "utf8") : "";
  for (const flags of [["--agent", "child"], ["--codex-job", "job-1"], ["--codex-thread", "thread-1"]]) {
    const r = f.invoke(f.orchestratorArgs(...flags));
    assert.equal(r.status, 1, flags[0]); assert.equal(r.stdout, "");
    assert.equal(r.stderr.trimEnd().split(/\r?\n/).length, 1); assert.match(r.stderr, /^Router: Orchestrator results cannot use/);
  }
  const bad = f.invoke(["result", "s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "bogus", "--outcome", "pass"]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Invalid worker.*orchestrator/);
  assert.equal(fs.existsSync(f.file) ? fs.readFileSync(f.file, "utf8") : "", before);
});

test("orchestrator records are invalid for worker validation and excluded from worker success rates", (t) => {
  const f = fixture(t), now = Date.now(), time = new Date(now).toISOString(), project = projectKey(f.project);
  const worker = { type: "result", time, sessionId: "s1", project, task: "t1", worker: "router:haiku-low", difficulty: "small", outcome: "pass" };
  const edit = { ...worker, worker: "orchestrator", outcome: "fail" };
  assert.equal(validResult(edit), false);
  const rows = aggregateStats([worker, edit, edit]);
  assert.deepEqual(rows.map((r) => [r.worker, r.attempts, r.passes]), [["router:haiku-low", 1, 1]]);
  assert.deepEqual(aggregateStats([edit]), []);
  assert.equal(orchestratorEdits([worker, edit, edit]), 2);
  const table = statsTable(rows);
  fs.mkdirSync(f.data, { recursive: true });
  fs.writeFileSync(f.file, [worker, edit].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(f.run(["stats"]), `${table}\nOrchestrator edits (not worker attempts): 1\n`);
});

test("stats prints the orchestrator line with --project and --since filters only when the count is above 0", (t) => {
  const f = fixture(t), now = Date.now(), project = projectKey(f.project);
  const base = { type: "result", sessionId: "s1", project, task: "t1", difficulty: "small", worker: "orchestrator", outcome: "pass" };
  const records = [
    { ...base, time: new Date(now).toISOString() },
    { ...base, time: new Date(now - 3 * 86400000).toISOString(), outcome: "fail" },
    { ...base, time: new Date(now).toISOString(), project: `${project}/other` },
    { ...base, time: "invalid" },
    { ...base, time: new Date(now).toISOString(), difficulty: "large" }
  ];
  records.forEach((r) => appendResult(f.file, r));
  assert.equal(orchestratorEdits(records, { now }), 3);
  assert.equal(orchestratorEdits(records, { project, now }), 2);
  assert.equal(orchestratorEdits(records, { project, since: 2, now }), 1);
  assert.equal(orchestratorEdits(records, { since: 2, now }), 2);
  const empty = statsTable([]);
  assert.equal(f.run(["stats"]), `${empty}\nOrchestrator edits (not worker attempts): 3\n`);
  assert.equal(f.run(["stats", "--project", f.project, "--since", "2"]), `${empty}\nOrchestrator edits (not worker attempts): 1\n`);
  assert.equal(f.run(["stats", "--since", "2"]), `${empty}\nOrchestrator edits (not worker attempts): 2\n`);
  assert.equal(f.run(["stats", "--project", path.join(f.home, "elsewhere")]), `${empty}\n`);
});

test("stats has no orchestrator line when no orchestrator records match", (t) => {
  const f = fixture(t), time = new Date().toISOString(), project = projectKey(f.project);
  appendResult(f.file, { type: "result", time, sessionId: "s1", project, task: "t1", difficulty: "small", worker: "router:haiku-low", outcome: "pass" });
  const output = f.run(["stats"]);
  assert.doesNotMatch(output, /Orchestrator edits/);
  assert.equal(output, `${statsTable(aggregateStats(readResults(f.file)))}\n`);
  appendResult(f.file, { type: "result", time, sessionId: "s1", project, task: "t2", difficulty: "small", worker: "orchestrator", outcome: "pass" });
  assert.equal(f.run(["stats", "--project", path.join(f.home, "elsewhere")]), `${statsTable([])}\n`);
});

test("ladder calculator ignores orchestrator records", (t) => {
  const f = fixture(t), time = new Date().toISOString(), project = projectKey(f.project);
  for (let i = 0; i < 10; i++) appendResult(f.file, { type: "result", time, sessionId: "s1", project, task: `t${i}`, worker: "router:haiku-low", difficulty: "small", outcome: i < 8 ? "pass" : "fail" });
  const before = f.run(["--results", f.file], "", calculator);
  for (let i = 0; i < 5; i++) appendResult(f.file, { type: "result", time, sessionId: "s1", project, task: `o${i}`, worker: "orchestrator", difficulty: "small", outcome: "fail" });
  assert.equal(f.run(["--results", f.file], "", calculator), before);
  assert.match(before, /router:haiku-low small: observed 80.0% \(8\/10\)/);
});
