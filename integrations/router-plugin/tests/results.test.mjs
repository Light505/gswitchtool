// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { costPerTask, needsApproval, workerNames } from "../scripts/workers.mjs";
import { appendResult, readResults, attemptRecord, transcriptTotals, resultRecord, aggregateStats, statsOptions, statsTable } from "../scripts/results.mjs";
import { projectKey } from "../scripts/router.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(plugin, "scripts/router.mjs");
const calculator = path.resolve(plugin, "../../scripts/router-ladder-calc.mjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-results-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSWITCH_ROUTER_SAMPLE_ROLL: "1" };
  const project = path.join(home, "project with spaces");
  fs.mkdirSync(project);
  const data = path.join(home, ".gswitchtool-router"), file = path.join(data, "results.jsonl");
  function invoke(args, input = "", entry = script) {
    return spawnSync(process.execPath, [entry, ...args], { cwd: home, env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", windowsHide: true });
  }
  function run(args, input, entry) {
    const r = invoke(args, input, entry);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }
  function setup(router) {
    const directory = path.join(home, ".gswitchtool"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "claude-setup.json"), JSON.stringify({ version: 1, setup: "router", router: { mode: "claude", claudeOnlyReview: "on", ...router } }));
  }
  function writeSession(value) {
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(data, "sessions/s1.json"), JSON.stringify(value));
  }
  const hook = (event, extra = {}) => JSON.parse(run(["hook", event], { session_id: "s1", cwd: project, ...extra }));
  const resultArgs = (...flags) => ["result", "s1", project, "--task", "t1", "--difficulty", "small", "--worker", "router:haiku-low", "--outcome", "pass", ...flags];
  return { home, env, project, data, file, invoke, run, setup, writeSession, hook, resultArgs };
}

test("cost approval has all 15 prices, exactly six expensive workers and unknown asks", (t) => {
  assert.deepEqual(costPerTask, {
    "haiku-low": .14, "haiku-medium": .23, "haiku-high": .36, "haiku-xhigh": .61, "haiku-max": 2.58,
    "sonnet-low": .48, "sonnet-medium": .62, "sonnet-high": 1.24, "sonnet-xhigh": 3.33, "sonnet-max": 14.19,
    "opus-low": .63, "opus-medium": 1.45, "opus-high": 2.16, "opus-xhigh": 4.82, "opus-max": 13.04
  });
  const expensive = ["opus-high", "haiku-max", "sonnet-xhigh", "opus-xhigh", "opus-max", "sonnet-max"];
  assert.deepEqual(workerNames.filter(needsApproval).sort(), [...expensive].sort());
  for (const name of expensive) assert.equal(needsApproval(name), true, name);
  for (const name of ["opus-medium", "opus-low", "sonnet-high"]) assert.equal(needsApproval(name), false, name);
  for (const name of ["unknown", "toString", "__proto__", undefined]) assert.equal(needsApproval(name), true);
  const f = fixture(t);
  f.setup({}); f.writeSession({});
  f.setup({ claudeAllowed: { haiku: ["max"], sonnet: ["high", "xhigh", "max"], opus: ["low", "medium", "high", "xhigh", "max"] } });
  f.run(["plan", "s1", f.project, "--task", "t1", "--kind", "implement", "--difficulty", "small"]);
  for (const name of [...expensive, "opus-medium", "opus-low", "sonnet-high"]) {
    const response = f.hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: `router:${name}`, prompt: "SCOPE: src/*\nTASK: t1" } });
    assert.equal(response.hookSpecificOutput?.permissionDecision, expensive.includes(name) ? "ask" : undefined, name);
  }
});

test("result records required and optional fields, Unicode title limit and append-only lines", (t) => {
  const f = fixture(t);
  assert.equal(f.run(f.resultArgs()), "Result: recorded t1 router:haiku-low pass\n");
  const original = fs.readFileSync(f.file, "utf8");
  const r = readResults(f.file)[0];
  assert.deepEqual(r, { type: "result", time: r.time, sessionId: "s1", project: projectKey(f.project), task: "t1", difficulty: "small",
    worker: "router:haiku-low", outcome: "pass", review: null, findings: null, sample: false, reason: null, step: null, title: null, agentId: null, codexJobId: null, codexThreadId: null });
  assert.ok(Number.isFinite(Date.parse(r.time)));
  const args = ["result", "s2", f.project, "--task", "t2", "--difficulty", "high-risk", "--worker", "codex:gpt-6.1-sol/low",
    "--outcome", "fail", "--reason", "review", "--step", "escalation", "--title", "😀".repeat(120), "--agent", "child", "--codex-job", "job-1", "--codex-thread", "thread-1"];
  assert.equal(f.run(args), "Result: recorded t2 codex:gpt-6.1-sol/low fail\n");
  const second = readResults(f.file)[1];
  assert.equal(second.title, "😀".repeat(120));
  assert.equal(second.agentId, "child"); assert.equal(second.codexJobId, "job-1"); assert.equal(second.codexThreadId, "thread-1");
  assert.equal(second.reason, "review"); assert.equal(second.step, "escalation");
  assert.ok(fs.readFileSync(f.file, "utf8").startsWith(original));
  assert.equal(fs.readFileSync(f.file, "utf8").trimEnd().split("\n").length, 2);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test("result rejects missing, duplicate, unknown and invalid values in one line without appending", (t) => {
  const f = fixture(t);
  f.run(f.resultArgs());
  const original = fs.readFileSync(f.file, "utf8"), base = f.resultArgs();
  const replace = (flag, value) => base.map((word, i) => i === base.indexOf(flag) + 1 ? value : word);
  const without = (flag) => base.filter((_, i) => i !== base.indexOf(flag) && i !== base.indexOf(flag) + 1);
  const invalid = [
    ["result"], ["result", "s1"], base.map((word, i) => i === 1 ? "" : word), base.map((word, i) => i === 2 ? "" : word),
    ...["--task", "--difficulty", "--worker", "--outcome"].map(without),
    replace("--task", ""), replace("--difficulty", "large"), replace("--outcome", "ok"),
    ...["haiku-low", "router:haiku-ultra", "router:bogus-low", "codex:gpt-6.1-sol", "codex:gpt-6.1-sol/nope", "codex:/low", "codex:a/b/low"].map((worker) => replace("--worker", worker)),
    [...base, "--reason", "wrong"], [...base, "--step", "later"], [...base, "--title", "x".repeat(121)],
    [...base, "--title", "a\nb"], [...base, "--agent", ""], [...base, "--codex-job"], [...base, "--codex-thread", "--step"],
    [...base, "--wat", "x"], [...base, "--worker", "router:opus-low"], [...base, "extra"]
  ];
  for (const args of invalid) {
    const r = f.invoke(args);
    assert.equal(r.status, 1, JSON.stringify(args)); assert.equal(r.stdout, "");
    assert.equal(r.stderr.trimEnd().split(/\r?\n/).length, 1); assert.match(r.stderr, /^Router: /);
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
  }
});

test("SubagentStop records only bound router workers, nullable metrics and key-only raw", (t) => {
  const f = fixture(t);
  f.setup({}); f.writeSession({ projectDir: projectKey(f.project), bindings: {
    a1: { type: "router:haiku-low", scope: ["src/*"], cwd: path.join(f.home, "worker") },
    other: { type: "general-purpose", scope: [] }
  } });
  assert.deepEqual(f.hook("SubagentStop", { agent_id: "a1", agent_type: "router:haiku-low", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }, duration_ms: 42, last_assistant_message: "SECRET_VALUE" }), {});
  const r = readResults(f.file)[0];
  assert.deepEqual(r, { type: "attempt", time: r.time, sessionId: "s1", project: projectKey(f.project), agentId: "a1", worker: "router:haiku-low", scope: ["src/*"], task: null, durationMs: null, tokens: 65, self: null,
    raw: { input: ["session_id", "cwd", "agent_id", "agent_type", "usage", "duration_ms", "last_assistant_message"], tool_response: [] } });
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /SECRET_VALUE|input_tokens|output_tokens/);
  assert.deepEqual(f.hook("SubagentStop", { agent_id: "a1" }), {});
  assert.equal(readResults(f.file)[1].tokens, null); assert.equal(readResults(f.file)[1].durationMs, null);
  for (const agent_id of ["unbound", "other"]) assert.deepEqual(f.hook("SubagentStop", { agent_id, agent_type: "router:haiku-low" }), {});
  assert.equal(readResults(f.file).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, "sessions/s1.json"), "utf8")).finished.length, 1);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test("PostToolUse Agent/Task records worker, response child ID, scope and supplied telemetry", (t) => {
  const f = fixture(t);
  f.setup({}); f.writeSession({ projectDir: projectKey(f.project), bindings: { a1: { type: "router:sonnet-high", scope: ["src/*", "tests/*"] } } });
  const input = { agent_id: "parent", tool_name: "Agent", tool_input: { subagent_type: "router:sonnet-high", prompt: "SECRET_VALUE\nSCOPE: src/*" },
    tool_response: { agentId: "a1", totalDurationMs: 125, totalTokens: 987, usage: { total_tokens: 999 }, content: "SECRET_VALUE" }, duration_ms: 100 };
  assert.deepEqual(f.hook("PostToolUse", input), {});
  let r = readResults(f.file)[0];
  assert.equal(r.worker, "router:sonnet-high"); assert.equal(r.agentId, "a1"); assert.equal(r.durationMs, 125); assert.equal(r.tokens, 987);
  assert.equal(r.project, projectKey(f.project)); assert.deepEqual(r.scope, ["src/*", "tests/*"]);
  assert.deepEqual(r.raw.tool_response, ["agentId", "totalDurationMs", "totalTokens", "usage", "content"]);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /SECRET_VALUE|parent|total_tokens/);
  assert.deepEqual(f.hook("PostToolUse", { tool_name: "Task", tool_input: { subagent_type: "router:haiku-low", prompt: "SCOPE: a/*, b/*" }, tool_response: { agent_id: "a2", usage: { input_tokens: 7, output_tokens: 9 } }, duration_ms: 55 }), {});
  r = readResults(f.file)[1];
  assert.equal(r.agentId, "a2"); assert.equal(r.tokens, 16); assert.equal(r.durationMs, null); assert.deepEqual(r.scope, ["a/*", "b/*"]);
  assert.deepEqual(f.hook("PostToolUse", { tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", prompt: "SCOPE: a/*" },
    tool_response: { isAsync: true, agentId: "a3", status: "async_launched" }, duration_ms: 1500 }), {});
  assert.equal(readResults(f.file).length, 2);
  assert.deepEqual(f.hook("PostToolUse", { agent_id: "parent", tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low" } }), {});
  r = readResults(f.file)[2];
  assert.equal(r.agentId, null); assert.equal(r.tokens, null); assert.equal(r.durationMs, null); assert.deepEqual(r.scope, []);
  for (const type of ["Explore", "Plan", "general-purpose", "router:unknown-low"]) f.hook("PostToolUse", { tool_name: "Agent", tool_input: { subagent_type: type } });
  f.hook("PostToolUse", { tool_name: "Bash", tool_input: { subagent_type: "router:haiku-low" } });
  assert.equal(readResults(f.file).length, 3);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test("telemetry accepts usage totals, counts, camel case and zero; ignores invalid fields", () => {
  const meta = { sessionId: "s", project: "p", worker: "router:haiku-low" };
  const cases = [
    [{ tool_response: { totalDurationMs: 0, totalTokens: 0 }, duration_ms: 99, usage: 99 }, 0, 0],
    [{ tool_response: { usage: { totalTokens: 5 } } }, null, 5],
    [{ tool_response: { usage: { total_tokens: 6, input_tokens: 100 } } }, null, 6],
    [{ tool_response: { usage: { inputTokens: 2, outputTokens: 3 } } }, null, 5],
    [{ tool_response: { usage: 7 } }, null, 7],
    [{ usage: { total_tokens: 8 }, duration_ms: 5 }, null, 8],
    [{ tool_response: { totalDurationMs: -1, totalTokens: "9", usage: {} }, usage: { input_tokens: 3, output_tokens: 4 } }, null, 7],
    [{ tool_response: { usage: { input_tokens: -1, output_tokens: "4" } }, duration_ms: "5" }, null, null],
    [{ tool_response: ["private"] }, null, null]
  ];
  for (const [input, duration, tokens] of cases) {
    const r = attemptRecord(input, meta);
    assert.equal(r.durationMs, duration); assert.equal(r.tokens, tokens);
  }
});

test("completion observations continue after routing is disabled", (t) => {
  const f = fixture(t);
  f.writeSession({ bindings: { a1: { type: "router:haiku-low", scope: ["a/*"] } } });
  assert.deepEqual(f.hook("SubagentStop", { agent_id: "a1" }), {});
  assert.deepEqual(f.hook("PostToolUse", { tool_name: "Task", tool_input: { subagent_type: "router:haiku-low" }, tool_response: { agentId: "a1" } }), {});
  assert.equal(readResults(f.file).length, 2);
});

test("results log tolerates missing files, CRLF, BOM, corrupt and partial lines", (t) => {
  const f = fixture(t);
  assert.deepEqual(readResults(f.file), []);
  appendResult(f.file, { type: "test", text: "one\ntwo" });
  assert.equal(fs.readFileSync(f.file, "utf8").split("\n").length, 2);
  fs.writeFileSync(f.file, '\uFEFF{"type":"one"}\r\n{bad}\r\nnull\r\n[]\r\n42\r\n\r\n{"type":"two"}\r\n{"partial":');
  assert.deepEqual(readResults(f.file), [{ type: "one" }, { type: "two" }]);
  const before = fs.readFileSync(f.file, "utf8");
  const writeSync = fs.writeSync;
  let writes = 0;
  // Assert the actual filesystem boundary uses one write for the full record.
  fs.writeSync = (...args) => { writes++; return writeSync(...args); };
  try { appendResult(f.file, { type: "three" }); }
  finally { fs.writeSync = writeSync; }
  assert.equal(writes, 1);
  assert.ok(fs.readFileSync(f.file, "utf8").startsWith(before));
  assert.deepEqual(readResults(f.file), [{ type: "one" }, { type: "two" }, { type: "three" }]);
});

test("stats merges completion metrics without double counting and isolates reused agent IDs", (t) => {
  const f = fixture(t), now = Date.now(), time = new Date(now).toISOString(), project = projectKey(f.project);
  const result = (extra = {}) => ({ type: "result", time, sessionId: "s1", project, task: "t1", worker: "router:haiku-low", difficulty: "small", outcome: "pass", agentId: "a1", ...extra });
  const attempt = (extra = {}) => ({ type: "attempt", time, sessionId: "s1", project, worker: "router:haiku-low", agentId: "a1", durationMs: null, tokens: null, ...extra });
  const records = [
    result(), result({ task: "t2", agentId: "a2", outcome: "fail" }), result({ task: "t3", agentId: null }),
    attempt({ durationMs: 100 }), attempt({ tokens: 40 }), attempt(), attempt({ agentId: "a2", durationMs: 300, tokens: 80 }),
    attempt({ sessionId: "other", durationMs: 999, tokens: 999 }), attempt({ agentId: "a3", project: `${project}/other`, durationMs: 999, tokens: 999 }),
    attempt({ worker: "router:opus-low", durationMs: 999, tokens: 999 }), attempt({ agentId: "unmatched", durationMs: 999, tokens: 999 }),
    result({ worker: "codex:gpt-6.1-sol/low", agentId: null, codexJobId: "j1", difficulty: "hard" }),
    result({ worker: "codex:gpt-6.1-sol/low", agentId: null, codexJobId: "j1", difficulty: "hard", outcome: "fail" }),
    result({ worker: "codex:gpt-6.1-sol/low", agentId: null, codexJobId: "j2", difficulty: "hard" }),
    result({ worker: "codex:gpt-6.1-sol/low", agentId: null, codexJobId: null, difficulty: "hard" }),
    result({ time: "invalid", task: "corrupt" }), result({ outcome: "unknown" }), result({ worker: "bogus" }),
    result({ worker: 17 }), result({ worker: "codex:haiku-low" }), { type: "unknown" }
  ];
  const rows = aggregateStats(records);
  assert.deepEqual(rows, [
    { worker: "codex:gpt-6.1-sol/low", difficulty: "hard", speed: "-", attempts: 4, passes: 3, successRate: .75, medianDurationMs: null, medianTokens: null, medianUsd: null, linkedJobs: 2 },
    { worker: "router:haiku-low", difficulty: "small", speed: "-", attempts: 3, passes: 2, successRate: 2 / 3, medianDurationMs: 200, medianTokens: 60, medianUsd: null, linkedJobs: 0 }
  ]);
  fs.mkdirSync(f.data, { recursive: true });
  fs.writeFileSync(f.file, records.map((r) => JSON.stringify(r)).join("\n") + "\n{corrupt}\n");
  assert.equal(f.run(["stats"]), `${statsTable(rows)}\n`);
  assert.match(f.run(["stats"]), /^Model\s+Difficulty\s+Codex speed\s+Tasks\s+Passed\s+Success\s+Typical time\s+Typical tokens\s+Typical cost\s+Codex jobs/);
  const tokenCell = (medianTokens) => statsTable([{ ...rows[1], medianTokens }]).split("\n")[1];
  assert.match(tokenCell(376822.5), /\s377k\s/); assert.match(tokenCell(1_234_567), /\s1\.2M\s/); assert.match(tokenCell(999), /\s999\s/);
  assert.match(f.run(["stats"]), /Claude Haiku, low\s+small\s+-\s+3\s+2\s+66.7%\s+0 s\s+60\s+-\s+-/);
  assert.match(f.run(["stats"]), /Codex Sol 6.1, low\s+hard\s+-\s+4\s+3\s+75.0%\s+-\s+-\s+-\s+2/);
  assert.equal(aggregateStats([result(), attempt({ durationMs: 0, tokens: 0 })])[0].medianTokens, 0);
  // Project is not part of attempt matching: the same session, worker and agent ID still match.
  assert.deepEqual(aggregateStats([result(), attempt({ project: `${project}/other`, durationMs: 77, tokens: 9 })])[0].medianDurationMs, 77);
  assert.deepEqual(aggregateStats([result(), attempt({ project: `${project}/other`, durationMs: 77, tokens: 9 })])[0].medianTokens, 9);
});

test("stats filters by normalized project and elapsed days and validates options", (t) => {
  const f = fixture(t), now = Date.now(), project = projectKey(f.project);
  const base = { type: "result", time: new Date(now).toISOString(), sessionId: "s1", project, task: "t1", difficulty: "trivial", worker: "router:haiku-low", outcome: "pass" };
  const records = [base, { ...base, time: new Date(now - 3 * 86400000).toISOString(), outcome: "fail" }, { ...base, project: `${project}/other` }];
  records.forEach((r) => appendResult(f.file, r));
  assert.equal(aggregateStats(records, { project, since: 2, now })[0].attempts, 1);
  assert.equal(aggregateStats(records, { project, now })[0].attempts, 2);
  assert.equal(aggregateStats(records, { since: 2, now })[0].attempts, 2);
  assert.match(f.run(["stats", "--project", `${f.project}${path.sep}`, "--since", "2"]), /trivial\s+-\s+1\s+1\s+100.0%/);
  if (process.platform === "win32") assert.match(f.run(["stats", "--project", f.project.toUpperCase().replaceAll("\\", "/"), "--since", "2"]), /trivial\s+-\s+1\s+1/);
  assert.equal(statsOptions(["--since", "0.5"], projectKey).since, .5);
  for (const args of [["--since", "no"], ["--since", "-1"], ["--since", "Infinity"], ["--since"], ["--project"], ["--since", "2", "--since", "3"], ["--unknown", "x"]]) {
    const r = f.invoke(["stats", ...args]);
    assert.equal(r.status, 1); assert.equal(r.stdout, ""); assert.equal(r.stderr.trimEnd().split(/\r?\n/).length, 1);
  }
  assert.equal(f.run(["stats", "--project", path.join(f.home, "elsewhere")]).trimEnd().split("\n").length, 1);
  const empty = path.join(f.home, "empty.jsonl"); assert.deepEqual(readResults(empty), []);
});

test("transcript totals count each message ID once, ignore bad lines and return null without a brief", (t) => {
  const f = fixture(t), at = (s) => `2026-10-08T10:00:${s}.000Z`;
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 30, output_tokens: 20 };
  const file = path.join(f.home, "agent.jsonl");
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: at("00"), message: { role: "user", content: "brief" } },
    { type: "assistant", uuid: "x1", promptId: "p1", timestamp: at("01"), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "assistant", uuid: "x2", promptId: "p1", timestamp: at("02"), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "user", uuid: "u3", promptId: "p2", timestamp: at("13"), message: { role: "user", content: [{ type: "tool_result" }] } },
    { type: "assistant", uuid: "x3", promptId: "p2", timestamp: at("15"), message: { id: "m2", model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
    { type: "attachment", uuid: "x4", promptId: "p2", timestamp: at("20") }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n{corrupt}\n");
  assert.deepEqual(transcriptTotals(file), { durationMs: 20_000, inputTokens: 11, cacheCreationTokens: 9, cacheReadTokens: 33, outputTokens: 22,
    tokens: 75, models: ["claude-haiku-5-5", "claude-sonnet-5-5"], usd: 0.000044225 });
  assert.equal(transcriptTotals(path.join(f.home, "missing.jsonl")), null);
  fs.writeFileSync(file, [
    { type: "assistant", uuid: "x", timestamp: at("01"), message: { id: "m", usage } },
    { type: "user", uuid: "meta", isMeta: true, timestamp: at("02"), message: { role: "user", content: "<system-reminder>..." } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.equal(transcriptTotals(file), null);
});

test("transcript totals price each message using its model and Haiku prompt tier", (t) => {
  const f = fixture(t), file = path.join(f.home, "prices.jsonl");
  const totals = (messages) => {
    fs.writeFileSync(file, [
      { type: "user", message: { content: "brief" } },
      ...messages.map((message, i) => ({ type: "assistant", message: { id: `m${i}`, ...message } }))
    ].map((line) => JSON.stringify(line)).join("\n"));
    return transcriptTotals(file);
  };
  const usage = { input_tokens: 10_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 70_000, output_tokens: 1_000 };
  const low = { model: "claude-haiku-5-5", usage };
  const high = { model: "claude-haiku-5-5", usage: { ...usage, cache_read_input_tokens: 70_001 } };
  // Exactly 100K stays in the lower tier; cache writes and reads count toward the prompt.
  assert.equal(totals([low]).usd, 0.0047);
  assert.ok(Math.abs(totals([high]).usd - 0.02350005) < 1e-12);
  assert.ok(Math.abs(totals([low, high]).usd - (0.0047 + 0.02350005)) < 1e-12);
  assert.equal(totals([{ model: "unknown", usage }]).usd, null);
  assert.equal(totals([{ usage }]).usd, null);
  assert.equal(totals([]).usd, null);
  assert.equal(totals([low, { model: "unknown", usage }]).usd, null);
  assert.equal(totals([{ model: "unknown", usage }, low]).usd, null);
  assert.equal(totals([low, { usage }]).usd, null);
  const split = { ephemeral_5m_input_tokens: 5_000, ephemeral_1h_input_tokens: 15_000 };
  const splitLow = { ...low, usage: { ...usage, cache_creation: split } };
  assert.equal(totals([splitLow]).usd, 0.005825);
  assert.ok(Math.abs(totals([{ ...high, usage: { ...high.usage, cache_creation: split } }]).usd - 0.02912505) < 1e-12);
  assert.equal(totals([{ model: "claude-sonnet-5-5", usage: splitLow.usage }]).usd, 0.1095);
  assert.equal(totals([{ model: "claude-opus-5-5", usage: splitLow.usage }]).usd, 0.219);
  // Without the split, all writes retain the 5-minute rate.
  assert.equal(totals([{ ...low, usage: { ...usage, cache_creation: {} } }]).usd, 0.0047);
  assert.equal(totals([{ model: "claude-sonnet-5-5", usage }]).usd, 0.087);
  assert.equal(totals([{ model: "claude-opus-5-5", usage }]).usd, 0.174);
});

test("transcript totals measure workers that share an orchestrator promptId independently", (t) => {
  const f = fixture(t), usage = { input_tokens: 4, output_tokens: 1 };
  const at = (second) => new Date(Date.parse("2026-10-08T10:00:00.000Z") + second * 1000).toISOString();
  const worker = (name, start, end) => {
    const file = path.join(f.home, `${name}.jsonl`);
    fs.writeFileSync(file, [
      { type: "user", promptId: "p1", timestamp: at(start), message: { role: "user", content: "brief" } },
      { type: "assistant", promptId: "p1", timestamp: at(end), message: { id: `${name}-1`, model: "claude-haiku-5-5", usage } }
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    return file;
  };
  assert.equal(transcriptTotals(worker("long", 0, 989)).durationMs, 989_000);
  const short = transcriptTotals(worker("short", 5, 20));
  assert.equal(short.durationMs, 15_000); assert.equal(short.tokens, 5);
});

test("transcript totals exclude idle time between a stop and a coordinator resume", (t) => {
  const f = fixture(t), file = path.join(f.home, "agent-resume.jsonl");
  const at = (second) => new Date(Date.parse("2026-10-08T10:00:00.000Z") + second * 1000).toISOString();
  const usage = { input_tokens: 2, output_tokens: 3 };
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: at(0), message: { role: "user", content: "brief" } },
    { type: "assistant", uuid: "x1", timestamp: at(5), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "user", uuid: "u2", isMeta: true, origin: { kind: "coordinator" }, timestamp: at(600), message: { role: "user", content: "resume" } },
    { type: "assistant", uuid: "x2", timestamp: at(610), message: { id: "m2", model: "claude-haiku-5-5", usage } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.deepEqual(transcriptTotals(file), {
    durationMs: 15_000, inputTokens: 4, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 6,
    tokens: 10, models: ["claude-haiku-5-5"], usd: 0.0000034
  });
});

test("transcript totals ignore harness reminders when starting segments", (t) => {
  const f = fixture(t), file = path.join(f.home, "agent-meta.jsonl"), at = (s) => `2026-10-08T10:00:${s}.000Z`;
  const usage = { input_tokens: 2, output_tokens: 3 };
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: at("00"), message: { role: "user", content: "brief" } },
    { type: "user", uuid: "meta", isMeta: true, timestamp: at("02"), message: { role: "user", content: "<system-reminder>..." } },
    { type: "assistant", uuid: "x1", timestamp: at("05"), message: { id: "m1", model: "claude-haiku-5-5", usage } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.equal(transcriptTotals(file).durationMs, 5000);
});

test("SubagentStop records the worker's cumulative totals and stats keep the latest", (t) => {
  const f = fixture(t), file = path.join(f.home, "agent.jsonl"), time = new Date().toISOString();
  const at = (s) => `2026-10-08T10:00:${s}.000Z`, usage = { input_tokens: 10, output_tokens: 20 };
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: at("00"), message: { role: "user", content: "brief" } },
    { type: "assistant", uuid: "x1", timestamp: at("03"), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "user", uuid: "u2", isMeta: true, origin: { kind: "coordinator" }, timestamp: at("10"), message: { role: "user", content: "resume" } },
    { type: "assistant", uuid: "x2", timestamp: at("12"), message: { id: "m2", model: "claude-haiku-5-5", usage } },
    { type: "assistant", uuid: "x3", timestamp: at("14"), message: { id: "m2", model: "claude-haiku-5-5", usage } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  f.setup({}); f.writeSession({ bindings: { a1: { type: "router:haiku-low", scope: [] } } });
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: file });
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: file });
  const r = readResults(f.file)[0];
  assert.equal(r.durationMs, 7000); assert.equal(r.tokens, 60); assert.deepEqual(r.models, ["claude-haiku-5-5"]);
  assert.equal(r.usd, 0.000022);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /brief|resume/);
  const base = { type: "attempt", time, sessionId: "s1", project: projectKey(f.project), worker: "router:haiku-low", agentId: "a5" };
  const result = { type: "result", time, sessionId: "s1", project: projectKey(f.project), task: "t1", worker: "router:haiku-low", difficulty: "small", outcome: "pass", agentId: "a5" };
  // Each stop records cumulative totals, so the latest value wins; a record without numbers keeps it.
  const records = [result, { ...base, durationMs: 1000, tokens: 10, usd: 0.1 }, { ...base, durationMs: 1500, tokens: 15, usd: 0.2 }, { ...base, durationMs: 1500, tokens: 15 }, base];
  assert.equal(aggregateStats(records)[0].medianDurationMs, 1500);
  assert.equal(aggregateStats(records)[0].medianTokens, 15);
  assert.equal(aggregateStats(records)[0].medianUsd, 0.2);
  assert.match(statsTable(aggregateStats(records)), /15\s+\$0\.20\s+-$/);
  assert.match(statsTable(aggregateStats([result, { ...base, usd: 0.0047 }])), /\$0\.00\s+-$/);
  assert.equal(aggregateStats([result, { ...base, usd: 0 }])[0].medianUsd, 0);
  assert.equal(aggregateStats([{ ...result, worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j1" }], { normalizeProject: projectKey })[0].worker, "codex-dev:gpt-6.1-sol/low");
  const codexDev = aggregateStats([
    { ...result, worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j1" },
    { ...result, worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j1" },
    { ...result, task: "t2", worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j2" }
  ]);
  assert.equal(codexDev[0].linkedJobs, 2);
  assert.match(statsTable(codexDev), /Codex Sol 6\.1, low\s+small\s+-\s+3\s+3\s+100\.0%\s+-\s+-\s+-\s+2$/);
  assert.equal(resultRecord(["s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "codex-dev:gpt-6.1-sol/low", "--outcome", "pass"], projectKey, "router-dev").worker, "codex-dev:gpt-6.1-sol/low");
  assert.throws(() => resultRecord(["s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "codex-dev:gpt-6.1-sol/low", "--outcome", "pass"], projectKey, "router"), /Invalid worker/);
});

test("stats table shows - for Median USD when no attempt has a cost", () => {
  const time = "2026-01-01T00:00:00.000Z";
  const project = "p1";
  const base = { type: "attempt", time, sessionId: "s1", project, worker: "router:haiku-low", agentId: "a5" };
  const result = { type: "result", time, sessionId: "s1", project, task: "t1", worker: "router:haiku-low", difficulty: "small", outcome: "pass", agentId: "a5" };
  const stats = aggregateStats([result, { ...base, durationMs: 1500, tokens: 15 }, { ...base, durationMs: 1500, tokens: 15 }]);
  assert.equal(stats[0].medianUsd, null);
  const lines = statsTable(stats).split("\n");
  assert.match(lines[1], /15\s+-\s+-$/);
  assert.match(lines[1], /^Claude Haiku, low\s+small\s+-\s+1\s+1\s+100\.0%\s+2 s\s+15\s+-\s+-$/);
  const header = lines[0].split(/\s{2,}/);
  const cells = lines[1].split(/\s{2,}/);
  assert.equal(cells[header.indexOf("Typical cost")], "-");
});

test("hooks always return JSON on malformed inputs and unwritable results, never log payload values", (t) => {
  const f = fixture(t);
  f.setup({}); f.writeSession({ bindings: { a1: { type: "router:haiku-low", scope: [] } } });
  for (const raw of ["{bad SECRET_VALUE", "null", "[]", "42", JSON.stringify({ session_id: {}, cwd: {}, agent_id: [], tool_input: [] })]) {
    for (const event of ["SubagentStop", "PostToolUse"]) assert.doesNotThrow(() => JSON.parse(f.run(["hook", event], raw)));
  }
  fs.mkdirSync(f.file);
  assert.deepEqual(f.hook("SubagentStop", { agent_id: "a1", last_assistant_message: "SECRET_VALUE" }), {});
  assert.deepEqual(f.hook("PostToolUse", { tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", prompt: "SECRET_VALUE" }, tool_response: { content: "SECRET_VALUE" } }), {});
  assert.doesNotMatch(fs.readFileSync(path.join(f.data, "router.log"), "utf8"), /SECRET_VALUE/);
  assert.deepEqual(fs.readdirSync(f.project), []);
});

test("concurrent result commands append complete independent records", async (t) => {
  const f = fixture(t);
  const write = (id) => new Promise((resolve, reject) => {
    const args = f.resultArgs().map((word) => word === "t1" ? id : word);
    const child = spawn(process.execPath, [script, ...args], { cwd: f.home, env: f.env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  const messages = await Promise.all([write("a"), write("b"), write("c")]);
  assert.equal(messages.length, 3);
  assert.deepEqual(readResults(f.file).map((r) => r.task).sort(), ["a", "b", "c"]);
  assert.equal(fs.readFileSync(f.file, "utf8").trimEnd().split("\n").length, 3);
});

test("PostToolUse registration and stats skill preserve explicit user invocation", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8")).hooks;
  assert.deepEqual(hooks.PostToolUse.map((h) => h.matcher), ["^Bash$", "^(Agent|Task)$"]);
  for (const entry of hooks.PostToolUse) assert.match(entry.hooks[0].command, /hook PostToolUse$/);
  assert.equal(hooks.PostToolUseFailure[0].matcher, "^Bash$");
  assert.match(hooks.PostToolUseFailure[0].hooks[0].command, /hook PostToolUseFailure$/);
  assert.match(hooks.PreToolUse[0].hooks[0].command, /hook PreToolUse$/);
  const skill = fs.readFileSync(path.join(plugin, "skills/stats/SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: stats\r?\n/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /Added by Light505 for gswitchtool \(2026\)\./);
  assert.match(skill, /router\.mjs" stats \$ARGUMENTS/);
  assert.match(skill, /Show the output as-is/);
});

test("ladder calculator reports observed rates only at ten results and preserves all picks", (t) => {
  const f = fixture(t), time = new Date().toISOString();
  const add = (worker, difficulty, count, passes) => {
    for (let i = 0; i < count; i++) appendResult(f.file, { type: "result", time, sessionId: "s1", project: projectKey(f.project), task: `t${i}`, worker, difficulty, outcome: i < passes ? "pass" : "fail" });
  };
  add("router:haiku-low", "small", 10, 8); add("router:haiku-low", "hard", 9, 9);
  add("codex:gpt-6.1-sol/low", "hard", 10, 6); add("codex:gpt-6-luna/max", "moderate", 10, 7);
  add("router:opus-medium", "high-risk", 10, 9); add("router:haiku-max", "trivial", 10, 7);
  fs.appendFileSync(f.file, '{corrupt}\n{"type":"attempt"}\n');
  const baseline = f.run([], "", calculator), output = f.run(["--results", f.file], "", calculator);
  assert.ok(output.startsWith(baseline));
  const report = output.slice(baseline.length);
  assert.match(report, /router:haiku-low small: observed 80.0% \(8\/10\), assumed 82.0%/);
  assert.doesNotMatch(report, /router:haiku-low hard:/);
  assert.match(report, /codex:gpt-6.1-sol\/low hard: observed 60.0% \(6\/10\), assumed 57.0%/);
  assert.match(report, /codex:gpt-6-luna\/max moderate: observed 70.0% \(7\/10\), assumed 70.5%/);
  assert.match(report, /router:opus-medium high-risk: observed 90.0% \(9\/10\), assumed n\/a/);
  assert.match(report, /router:haiku-max trivial: observed 70.0% \(7\/10\), assumed n\/a/);
  assert.match(f.run(["--results", path.join(f.home, "missing.jsonl")], "", calculator), /No worker\/difficulty has at least 10/);
  const failed = f.invoke(["--results"], "", calculator);
  assert.equal(failed.status, 1); assert.equal(failed.stderr.trimEnd().split(/\r?\n/).length, 1);
});

test("stats reads last Codex job telemetry, groups speeds and compares timed runs", (t) => {
  const f = fixture(t), time = new Date().toISOString(), worker = "codex:gpt-6.1-sol/low";
  const log = path.join(f.home, ".gswitchtool", "codex-runs.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const runs = [
    { jobId: "fast1", speed: "normal", codexMs: 999999, tokens: 999999 },
    { jobId: "fast1", speed: "fast", codexMs: 1000, tokens: 10 },
    // Run details added later do not change the stats.
    { jobId: "fast2", speed: "fast", codexMs: 3000, tokens: 30,
      selfReport: { status: "done", confidence: "high", felt: "hard", verifyFails: 2 },
      filesChanged: 4, linesAdded: 90, linesDeleted: 12, verify: "failed", verifyRetries: 1, scopeRequests: 2,
      tokenBreakdown: { input: 20, cachedInput: 5, output: 10, reasoningOutput: 4 },
      longPromptTokens: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 } },
    { jobId: "normal", speed: "normal", codexMs: 6000, tokens: 60 },
    { jobId: "mixed", speed: "mixed", codexMs: null, tokens: null },
    { jobId: "bad", speed: "fast", codexMs: "123", tokens: -1 }, {}
  ];
  fs.writeFileSync(log, runs.map((r) => JSON.stringify(r)).join("\n") + "\n{malformed}\n");
  for (const [i, job] of ["fast1", "fast2", "normal", "mixed", "bad", "unknown"].entries()) {
    appendResult(f.file, { type: "result", time, sessionId: "s1", project: projectKey(f.project), task: `t${i}`, difficulty: "small", worker, outcome: "pass", codexJobId: job });
  }
  const output = f.run(["stats"]);
  assert.match(output, /Difficulty\s+Codex speed\s+Tasks/);
  assert.match(output, /small\s+Fast\s+3\s+3\s+100.0%\s+2 s\s+20/);
  assert.match(output, /small\s+Normal\s+1\s+1\s+100.0%\s+6 s\s+60/);
  assert.match(output, /small\s+Mixed\s+1\s+1\s+100.0%\s+-\s+-/);
  assert.match(output, /small\s+-\s+1\s+1\s+100.0%\s+-\s+-/);
  assert.ok(output.includes(`Fast vs Normal, Codex Sol 6.1, low:2 fast, median 2.0s · 1 normal, median 6.0s · 3.00x faster`));
  fs.rmSync(log);
  assert.doesNotMatch(f.run(["stats"]), /Fast vs Normal/);
  // A Dev build reads only its own app directory, using the shared path helper.
  const copy = path.join(f.home, "plugin"); fs.cpSync(plugin, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "router-target.json"), JSON.stringify({ appDataDir: ".gswitchtool-dev" }));
  const devLog = path.join(f.home, ".gswitchtool-dev", "codex-runs.jsonl");
  fs.mkdirSync(path.dirname(devLog));
  fs.writeFileSync(devLog, runs.map((r) => JSON.stringify({ ...r, codexMs: r.jobId === "normal" ? 1000 : r.codexMs })).join("\n"));
  const dev = f.run(["stats"], "", path.join(copy, "scripts/router.mjs"));
  assert.ok(dev.includes(`Fast vs Normal, Codex Sol 6.1, low:2 fast, median 2.0s · 1 normal, median 1.0s · 2.00x slower`));
});
