// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { costPerTask, needsApproval, workerNames } from "../scripts/workers.mjs";
import { appendResult, readResults, attemptRecord, transcriptRun, resultRecord, aggregateStats, statsOptions, statsTable } from "../scripts/results.mjs";
import { projectKey } from "../scripts/router.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(plugin, "scripts/router.mjs");
const calculator = path.resolve(plugin, "../../scripts/router-ladder-calc.mjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-results-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
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
  function writeSession(value) {
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(data, "sessions/s1.json"), JSON.stringify(value));
  }
  const hook = (event, extra = {}) => JSON.parse(run(["hook", event], { session_id: "s1", cwd: project, ...extra }));
  const resultArgs = (...flags) => ["result", "s1", project, "--task", "t1", "--difficulty", "small", "--worker", "router:haiku-low", "--outcome", "pass", ...flags];
  return { home, env, project, data, file, invoke, run, writeSession, hook, resultArgs };
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
  f.writeSession({ mode: "claude" });
  fs.writeFileSync(path.join(f.data, "config.json"), JSON.stringify({ claudeAllowed: { haiku: ["max"], sonnet: ["high", "xhigh", "max"], opus: ["low", "medium", "high", "xhigh", "max"] } }));
  for (const name of [...expensive, "opus-medium", "opus-low", "sonnet-high"]) {
    const response = f.hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: `router:${name}`, prompt: "SCOPE: src/*" } });
    assert.equal(response.hookSpecificOutput?.permissionDecision, expensive.includes(name) ? "ask" : undefined, name);
  }
});

test("result records required and optional fields, Unicode title limit and append-only lines", (t) => {
  const f = fixture(t);
  assert.equal(f.run(f.resultArgs()), "Result: recorded t1 router:haiku-low pass\n");
  const original = fs.readFileSync(f.file, "utf8");
  const r = readResults(f.file)[0];
  assert.deepEqual(r, { type: "result", time: r.time, sessionId: "s1", project: projectKey(f.project), task: "t1", difficulty: "small",
    worker: "router:haiku-low", outcome: "pass", reason: null, step: null, title: null, agentId: null, codexJobId: null, codexThreadId: null });
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
  f.writeSession({ mode: "claude", projectDir: projectKey(f.project), bindings: {
    a1: { type: "router:haiku-low", scope: ["src/*"], cwd: path.join(f.home, "worker") },
    other: { type: "general-purpose", scope: [] }
  } });
  assert.deepEqual(f.hook("SubagentStop", { agent_id: "a1", agent_type: "router:haiku-low", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }, duration_ms: 42, last_assistant_message: "SECRET_VALUE" }), {});
  const r = readResults(f.file)[0];
  assert.deepEqual(r, { type: "attempt", time: r.time, sessionId: "s1", project: projectKey(f.project), agentId: "a1", worker: "router:haiku-low", scope: ["src/*"], durationMs: null, tokens: 65,
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
  f.writeSession({ mode: "claude", projectDir: projectKey(f.project), bindings: { a1: { type: "router:sonnet-high", scope: ["src/*", "tests/*"] } } });
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
  f.writeSession({ mode: "off", bindings: { a1: { type: "router:haiku-low", scope: ["a/*"] } } });
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
    { worker: "codex:gpt-6.1-sol/low", difficulty: "hard", attempts: 4, passes: 3, successRate: .75, medianDurationMs: null, medianTokens: null, linkedJobs: 2 },
    { worker: "router:haiku-low", difficulty: "small", attempts: 3, passes: 2, successRate: 2 / 3, medianDurationMs: 200, medianTokens: 60, linkedJobs: 0 }
  ]);
  fs.mkdirSync(f.data, { recursive: true });
  fs.writeFileSync(f.file, records.map((r) => JSON.stringify(r)).join("\n") + "\n{corrupt}\n");
  assert.equal(f.run(["stats"]), `${statsTable(rows)}\n`);
  assert.match(f.run(["stats"]), /router:haiku-low\s+small\s+3\s+2\s+66.7%\s+200\s+60\s+-/);
  assert.match(f.run(["stats"]), /codex:gpt-6.1-sol\/low\s+hard\s+4\s+3\s+75.0%\s+-\s+-\s+2/);
  assert.equal(aggregateStats([result(), attempt({ durationMs: 0, tokens: 0 })])[0].medianTokens, 0);
});

test("stats filters by normalized project and elapsed days and validates options", (t) => {
  const f = fixture(t), now = Date.now(), project = projectKey(f.project);
  const base = { type: "result", time: new Date(now).toISOString(), sessionId: "s1", project, task: "t1", difficulty: "trivial", worker: "router:haiku-low", outcome: "pass" };
  const records = [base, { ...base, time: new Date(now - 3 * 86400000).toISOString(), outcome: "fail" }, { ...base, project: `${project}/other` }];
  records.forEach((r) => appendResult(f.file, r));
  assert.equal(aggregateStats(records, { project, since: 2, now })[0].attempts, 1);
  assert.equal(aggregateStats(records, { project, now })[0].attempts, 2);
  assert.equal(aggregateStats(records, { since: 2, now })[0].attempts, 2);
  assert.match(f.run(["stats", "--project", `${f.project}${path.sep}`, "--since", "2"]), /trivial\s+1\s+1\s+100.0%/);
  if (process.platform === "win32") assert.match(f.run(["stats", "--project", f.project.toUpperCase().replaceAll("\\", "/"), "--since", "2"]), /trivial\s+1\s+1/);
  assert.equal(statsOptions(["--since", "0.5"], projectKey).since, .5);
  for (const args of [["--since", "no"], ["--since", "-1"], ["--since", "Infinity"], ["--since"], ["--project"], ["--since", "2", "--since", "3"], ["--unknown", "x"]]) {
    const r = f.invoke(["stats", ...args]);
    assert.equal(r.status, 1); assert.equal(r.stdout, ""); assert.equal(r.stderr.trimEnd().split(/\r?\n/).length, 1);
  }
  assert.equal(f.run(["stats", "--project", path.join(f.home, "elsewhere")]).trimEnd().split("\n").length, 1);
  const empty = path.join(f.home, "empty.jsonl"); assert.deepEqual(readResults(empty), []);
});

test("transcript run takes the last run, counts each message ID once and ignores bad lines", (t) => {
  const f = fixture(t), at = (s) => `2026-10-08T10:00:${s}.000Z`;
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 30, output_tokens: 20 };
  const file = path.join(f.home, "agent.jsonl");
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: at("00"), message: { role: "user", content: "brief" } },
    { type: "assistant", uuid: "x1", timestamp: at("01"), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "assistant", uuid: "x2", timestamp: at("02"), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "user", uuid: "u2", timestamp: at("10"), message: { role: "user", content: "resume" } },
    { type: "assistant", uuid: "x3", timestamp: at("12"), message: { id: "m2", model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
    { type: "user", uuid: "u3", timestamp: at("13"), message: { role: "user", content: [{ type: "tool_result" }] } },
    { type: "attachment", uuid: "x4", timestamp: at("15") }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n{corrupt}\n");
  assert.deepEqual(transcriptRun(file), { run: "u2", durationMs: 5000, inputTokens: 1, cacheCreationTokens: 4, cacheReadTokens: 3, outputTokens: 2,
    tokens: 10, models: ["claude-sonnet-5-5"] });
  assert.equal(transcriptRun(path.join(f.home, "missing.jsonl")), null);
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "x", timestamp: at("01"), message: { id: "m", usage } }) + "\n");
  assert.equal(transcriptRun(file), null);
});

test("transcript run follows the latest promptId across injected meta lines", (t) => {
  const f = fixture(t), file = path.join(f.home, "agent-prompt-id.jsonl");
  const at = (second) => "2026-10-08T10:00:" + second + ".000Z";
  const usage = (input, output) => ({ input_tokens: input, output_tokens: output });
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", promptId: "p1", timestamp: at("00"), message: { role: "user", content: "brief" } },
    { type: "assistant", timestamp: at("01"), message: { id: "m1", model: "claude-haiku-5-5", usage: usage(100, 10) } },
    { type: "user", uuid: "meta1", promptId: "p1", isMeta: true, timestamp: at("02"), message: { role: "user", content: "<system-reminder>..." } },
    { type: "assistant", timestamp: at("10"), message: { id: "m2", model: "claude-haiku-5-5", usage: usage(200, 20) } },
    { type: "user", uuid: "u2", promptId: "p2", timestamp: at("20"), message: { role: "user", content: "resume" } },
    { type: "assistant", timestamp: at("21"), message: { id: "m3", model: "claude-sonnet-5-5", usage: usage(30, 3) } },
    { type: "user", uuid: "meta2", promptId: "p2", isMeta: true, timestamp: at("39"), message: { role: "user", content: "[handback-send-enforce]..." } },
    { type: "assistant", timestamp: at("40"), message: { id: "m4", model: "claude-opus-5-5", usage: usage(40, 4) } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.deepEqual(transcriptRun(file), {
    run: "p2", durationMs: 20_000, inputTokens: 70, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 7,
    tokens: 77, models: ["claude-sonnet-5-5", "claude-opus-5-5"]
  });
});

test("transcript run fallback ignores meta user lines when promptId is absent", (t) => {
  const f = fixture(t), file = path.join(f.home, "agent-no-prompt-id.jsonl");
  const usage = { input_tokens: 2, output_tokens: 3 };
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: "2026-10-08T10:00:00.000Z", message: { role: "user", content: "brief" } },
    { type: "assistant", timestamp: "2026-10-08T10:00:01.000Z", message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "user", uuid: "meta", isMeta: true, timestamp: "2026-10-08T10:00:02.000Z", message: { role: "user", content: "<system-reminder>..." } },
    { type: "assistant", timestamp: "2026-10-08T10:00:10.000Z", message: { id: "m2", model: "claude-haiku-5-5", usage } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.deepEqual(transcriptRun(file), {
    run: "u1", durationMs: 10_000, inputTokens: 4, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 6,
    tokens: 10, models: ["claude-haiku-5-5"]
  });
});

test("SubagentStop reads the transcript run once per stop and stats sum runs", (t) => {
  const f = fixture(t), file = path.join(f.home, "agent.jsonl"), time = new Date().toISOString();
  const at = (s) => `2026-10-08T10:00:${s}.000Z`, usage = { input_tokens: 10, output_tokens: 20 };
  fs.writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: at("00"), message: { role: "user", content: "brief" } },
    { type: "assistant", uuid: "x1", timestamp: at("03"), message: { id: "m1", model: "claude-haiku-5-5", usage } },
    { type: "user", uuid: "u2", timestamp: at("10"), message: { role: "user", content: "resume" } },
    { type: "assistant", uuid: "x2", timestamp: at("12"), message: { id: "m2", model: "claude-haiku-5-5", usage } },
    { type: "assistant", uuid: "x3", timestamp: at("14"), message: { id: "m2", model: "claude-haiku-5-5", usage } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  f.writeSession({ mode: "claude", bindings: { a1: { type: "router:haiku-low", scope: [] } } });
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: file });
  f.hook("SubagentStop", { agent_id: "a1", agent_transcript_path: file });
  let r = readResults(f.file)[0];
  assert.equal(r.run, "u2"); assert.equal(r.durationMs, 4000); assert.equal(r.tokens, 30); assert.deepEqual(r.models, ["claude-haiku-5-5"]);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /brief|resume/);
  const base = { type: "attempt", time, sessionId: "s1", project: projectKey(f.project), worker: "router:haiku-low", agentId: "a5" };
  const result = { type: "result", time, sessionId: "s1", project: projectKey(f.project), task: "t1", worker: "router:haiku-low", difficulty: "small", outcome: "pass", agentId: "a5" };
  const records = [result, { ...base, run: "u1", durationMs: 1000, tokens: 10 }, { ...base, run: "u1", durationMs: 1000, tokens: 10 },
    { ...base, run: "u2", durationMs: 500, tokens: 5 }, { ...base, run: "u2", durationMs: 500, tokens: 5 }];
  assert.equal(aggregateStats(records)[0].medianDurationMs, 1500);
  assert.equal(aggregateStats(records)[0].medianTokens, 15);
  assert.equal(aggregateStats([{ ...result, worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j1" }], { normalizeProject: projectKey })[0].worker, "codex-dev:gpt-6.1-sol/low");
  const codexDev = aggregateStats([
    { ...result, worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j1" },
    { ...result, worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j1" },
    { ...result, task: "t2", worker: "codex-dev:gpt-6.1-sol/low", agentId: null, codexJobId: "j2" }
  ]);
  assert.equal(codexDev[0].linkedJobs, 2);
  assert.match(statsTable(codexDev), /codex-dev:gpt-6\.1-sol\/low\s+small\s+3\s+3\s+100\.0%\s+-\s+-\s+2$/);
  assert.equal(resultRecord(["s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "codex-dev:gpt-6.1-sol/low", "--outcome", "pass"], projectKey, "router-dev").worker, "codex-dev:gpt-6.1-sol/low");
  assert.throws(() => resultRecord(["s1", f.project, "--task", "t1", "--difficulty", "small", "--worker", "codex-dev:gpt-6.1-sol/low", "--outcome", "pass"], projectKey, "router"), /Invalid worker/);
});

test("hooks always return JSON on malformed inputs and unwritable results, never log payload values", (t) => {
  const f = fixture(t);
  f.writeSession({ mode: "claude", bindings: { a1: { type: "router:haiku-low", scope: [] } } });
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
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(hooks.PostToolUse[0].matcher, "^(Agent|Task)$");
  assert.match(hooks.PostToolUse[0].hooks[0].command, /hook PostToolUse$/);
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
