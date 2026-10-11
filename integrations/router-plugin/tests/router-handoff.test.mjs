// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(plugin, "scripts", "router.mjs");
const line = (value) => `${JSON.stringify(value)}\n`;
// An assistant transcript line whose input side adds up to `size` tokens.
const assistant = (size, text = "ok", extra = {}) => line({ type: "assistant", isSidechain: false, ...extra,
  message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 1000, cache_read_input_tokens: size - 2000, cache_creation_input_tokens: 1000, output_tokens: 5 } } });
const soft = (of) => `Session ${of}: finish current tasks, start no new ones`;
const resumeHint = "Resume a running worker with SendMessage or a Codex thread with --resume-thread.";

function fixture(t, { setup = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-handoff-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, GSWITCH_ROUTER_SAMPLE_ROLL: "1" };
  const data = path.join(home, ".gswitchtool-router");
  const setupFile = path.join(home, ".gswitchtool", "claude-setup.json");
  const transcript = path.join(home, "transcript.jsonl");
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const f = { home, project, data, setupFile, transcript, write };
  f.setup = (value = {}) => write(setupFile, { version: 1, setup: "router", router: { mode: "claude", claudeOnlyReview: "off" }, ...value });
  if (setup) f.setup();
  // A small first message keeps the loop guard (starting size) out of the way.
  f.size = (n, text) => write(transcript, assistant(Math.min(n, 40000)) + assistant(n, text));
  f.run = (args, input, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: home, env: { ...env, ...extraEnv }, input: JSON.stringify(input ?? {}), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  f.hook = (event, extra = {}, extraEnv = {}) => JSON.parse(f.run(["hook", event], { session_id: "s1", cwd: project, hook_event_name: event, transcript_path: transcript, ...extra }, extraEnv));
  f.context = (event, extra, extraEnv) => f.hook(event, extra, extraEnv).hookSpecificOutput?.additionalContext;
  f.reason = (result) => result.hookSpecificOutput?.permissionDecisionReason;
  f.denied = (result) => result.hookSpecificOutput?.permissionDecision === "deny";
  f.handoff = (id = "s1") => JSON.parse(fs.readFileSync(path.join(data, "handoffs", `${id}.json`), "utf8"));
  f.session = (id = "s1") => JSON.parse(fs.readFileSync(path.join(data, "sessions", `${id}.json`), "utf8"));
  f.git = (args, cwd = project) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  f.init = () => {
    f.git(["init", "-b", "main"]);
    f.git(["config", "user.name", "Router Test"]); f.git(["config", "user.email", "router@example.invalid"]); f.git(["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(project, "file.txt"), "base\n");
    f.git(["add", "."]); f.git(["commit", "-m", "base commit"]);
  };
  return f;
}

test("the session size is the newest main-thread usage, read from the end of a large transcript", (t) => {
  const f = fixture(t);
  f.setup({ sessionLimit: 100000 });
  const filler = line({ type: "user", message: { role: "user", content: "x".repeat(400000) } });
  fs.writeFileSync(f.transcript, assistant(50000) + filler + assistant(85000, "newest") + assistant(200000, "side", { isSidechain: true }) +
    line({ type: "user", message: { role: "user", content: "hi" } }) + "{broken\n" + filler);
  assert.match(f.context("UserPromptSubmit"), new RegExp(`${soft("85k of 100k")}$`));
  f.size(79000);
  assert.doesNotMatch(f.context("UserPromptSubmit"), /Session/);
  fs.writeFileSync(f.transcript, assistant(90000, "side", { isSidechain: true }));
  assert.doesNotMatch(f.context("UserPromptSubmit"), /Session/);
  fs.rmSync(f.transcript);
  assert.doesNotMatch(f.context("UserPromptSubmit"), /Session/);
  assert.equal(f.hook("Stop").decision, undefined);
});

test("the starting size is the first main-thread usage, read from the start of a large transcript", (t) => {
  const f = fixture(t);
  f.setup({ sessionLimit: 100000 });
  const filler = line({ type: "user", message: { role: "user", content: "x".repeat(400000) } });
  // A sidechain (300k) or synthetic (85k) first line would trigger the guard; the real first usage (63k) does not.
  fs.writeFileSync(f.transcript, "{broken\n" + filler + assistant(300000, "side", { isSidechain: true }) + line({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 85000 } } }) +
    filler + assistant(63000, "first") + filler + assistant(90000, "newest"));
  assert.match(f.context("UserPromptSubmit"), /Session 90k of 100k: finish current tasks/);
  assert.equal(f.session().startSize, undefined);
  fs.writeFileSync(f.transcript, filler + assistant(85000, "first") + filler + assistant(90000, "newest"));
  assert.match(f.context("UserPromptSubmit"), /Session limit 100k is below this session's starting size \(85k\): raise it in GSwitch → Claude Code/);
});

test("loop guard: a session starting at 80% of the limit is not limited, and the Router line says to raise it", (t) => {
  const f = fixture(t);
  f.setup({ sessionLimit: 100000 });
  fs.writeFileSync(f.transcript, assistant(85000) + assistant(130000, "newest"));
  const guard = "Session limit 100k is below this session's starting size (85k): raise it in GSwitch → Claude Code";
  assert.ok(f.context("UserPromptSubmit").startsWith("Router: mode=claude · ") && f.context("UserPromptSubmit").endsWith(` · ${guard}`));
  assert.equal(f.hook("Stop").decision, undefined);
  assert.equal(f.hook("UserPromptSubmit", { prompt: "go" }).decision, undefined);
  assert.doesNotMatch(f.reason(f.hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", prompt: "Do it\nSCOPE: src/*\nTASK: t1" } })) ?? "", /^Session /);
  assert.equal(f.hook("PreCompact", { trigger: "auto" }).decision, "block");
  assert.notEqual(f.session().full, true);
  f.write(f.setupFile, { version: 1, setup: "claude-only", router: { mode: "mixed", claudeOnlyReview: "on" }, sessionLimit: 100000 });
  assert.equal(f.context("UserPromptSubmit"), guard);
  // A handoff still loads in a guarded session.
  f.write(path.join(f.data, "handoffs", "old.json"), { version: 1, sessionId: "old", project: f.project, createdAt: "2026-02-02T10:00:00.000Z", size: 1, limit: 1, judgement: "Old goal", facts: {}, nextRequests: [], usedAt: null, usedBy: null });
  assert.match(f.context("SessionStart", { source: "startup" }), /Old goal/);
  // A session already marked full stays full.
  f.write(path.join(f.data, "sessions", "s2.json"), { full: true });
  assert.equal(f.hook("UserPromptSubmit", { session_id: "s2", prompt: "go" }).decision, "block");
  // A lower first usage: the limit applies as before.
  f.write(f.transcript, assistant(40000) + assistant(130000, "newest"));
  fs.rmSync(path.join(f.data, "sessions", "s1.json"));
  assert.equal(f.hook("UserPromptSubmit", { prompt: "go" }).decision, "block");
});

test("sessionLimit: 100000 to 1000000 as an integer, anything else means 250000", (t) => {
  const f = fixture(t);
  f.size(85000);
  f.setup({ sessionLimit: 100000 });
  assert.match(f.context("UserPromptSubmit"), new RegExp(`${soft("85k of 100k")}$`));
  f.size(200000);
  for (const value of [99999, 1000001, 150000.5, "100000", null, true, undefined]) {
    f.setup({ sessionLimit: value });
    assert.match(f.context("UserPromptSubmit"), new RegExp(`${soft("200k of 250k")}$`), String(value));
  }
  f.write(f.setupFile, "{broken");
  assert.equal(f.context("UserPromptSubmit"), soft("200k of 250k"));
  fs.rmSync(f.setupFile);
  assert.equal(f.context("UserPromptSubmit"), soft("200k of 250k"));
  f.setup({ sessionLimit: 1000000 }); f.size(800000);
  assert.match(f.context("UserPromptSubmit"), new RegExp(`${soft("800k of 1000k")}$`));
});

test("soft limit: the Router line says so, in every mode, and new launches are denied", (t) => {
  const f = fixture(t);
  f.size(205000);
  assert.match(f.context("UserPromptSubmit"), new RegExp(`^Router: mode=claude · .* · Codex review in claude mode: off · ${soft("205k of 250k")}$`));
  f.size(199000);
  assert.doesNotMatch(f.context("UserPromptSubmit"), /Session/);
  f.size(205000);
  const reason = `Session 205k of 250k: finish current tasks, start no new ones. ${resumeHint}`;
  const agent = (type, prompt = "Do it\nSCOPE: src/*\nTASK: t1", extra = {}) => f.hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: type, prompt }, ...extra });
  const invoke = (tail = "") => f.hook("PreToolUse", { tool_name: "Bash", tool_input: { command: `node "/p/codex/scripts/codex-companion.mjs" invoke-run --model m --effort low ${tail}"brief"` } });
  for (const mode of ["claude", "mixed", "off"]) {
    if (mode === "off") f.write(f.setupFile, { version: 1, setup: "claude-only", router: { mode: "mixed", claudeOnlyReview: "on" } });
    else f.setup({ router: { mode, claudeOnlyReview: "off" } });
    if (mode === "off") assert.equal(f.context("UserPromptSubmit"), soft("205k of 250k"));
    assert.equal(f.reason(agent("router:haiku-low")), reason, mode);
    assert.equal(f.reason(agent("codex:codex-runner", "run codex")), reason, mode);
    assert.equal(f.reason(agent("codex-dev:codex-runner", "run codex")), reason, mode);
    assert.deepEqual(agent("codex:codex-runner", "run codex --resume-thread abc123"), {}, mode);
    assert.deepEqual(agent("Explore", "look"), {}, mode);
    assert.deepEqual(agent("router-dev:haiku-low"), {}, mode);
    assert.equal(f.reason(invoke()), reason, mode);
    assert.deepEqual(invoke("--resume-thread abc123 "), {}, mode);
    assert.deepEqual(f.hook("PreToolUse", { tool_name: "SendMessage", tool_input: { to: "a1", message: "go on" } }), {}, mode);
  }
  // A subagent's call measures the main transcript the session file remembers.
  f.setup();
  f.size(1000);
  assert.equal(f.session().transcriptPath, f.transcript);
  assert.doesNotMatch(f.reason(agent("router:haiku-low", undefined, { agent_id: "a9", transcript_path: path.join(f.home, "missing.jsonl") })) ?? "", /^Session/);
  f.size(205000);
  assert.equal(f.reason(agent("router:haiku-low", undefined, { agent_id: "a9", transcript_path: path.join(f.home, "missing.jsonl") })), reason);
});

test("Stop: not full does nothing; full asks for the handoff once, then saves it with the facts", (t) => {
  const f = fixture(t);
  f.init();
  fs.writeFileSync(path.join(f.project, "new1.txt"), "x"); fs.writeFileSync(path.join(f.project, "new2.txt"), "y");
  const worktree = path.join(f.home, "worker-tree");
  f.git(["worktree", "add", "-b", "w", worktree]);
  // Open task with a failed attempt and a Codex thread, a running worker, running and gone Codex jobs.
  f.write(path.join(f.data, "results.jsonl"), line({ type: "plan", sessionId: "s1", task: "t2", kind: "implement", difficulty: "hard", title: "Parser", time: "2026-01-01T00:00:00Z" }) +
    line({ type: "result", sessionId: "s1", task: "t2", worker: "router:sonnet-high", outcome: "fail", reason: "verify", codexThreadId: "th1" }) +
    line({ type: "plan", sessionId: "s1", task: "t3", kind: "docs", difficulty: "small", title: "Done one" }) +
    line({ type: "result", sessionId: "s1", task: "t3", worker: "router:haiku-low", outcome: "pass" }));
  f.write(path.join(f.data, "sessions", "s1.json"), { bindings: { a1: { type: "router:haiku-low", task: "t2", scope: [] }, a2: { type: "router:haiku-low", task: "t3", scope: [] } },
    finished: [{ agentId: "a2", time: Date.now() }] });
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  f.write(path.join(f.home, ".claude", "plugins", "data", "codex-test", "state", "w-1", "state.json"), { jobs: [
    { id: "job1", sessionId: "s1", status: "running", threadId: "th1", title: "Parser fix", pid: dead },
    { id: "job2", sessionId: "other", status: "running", threadId: "th2", title: "x" },
    { id: "job3", sessionId: "s1", status: "completed", threadId: "th3", title: "y" }] });
  f.write(path.join(f.home, ".claude", "plugins", "data", "codex-dev-test", "state", "w-1", "state.json"), { jobs: [{ id: "devjob", sessionId: "s1", status: "running", threadId: "th4", title: "z" }] });

  f.size(200000);
  assert.deepEqual(f.hook("Stop"), {});
  f.size(262000);
  assert.deepEqual(f.hook("Stop", { agent_id: "a1" }), {});
  const asked = f.hook("Stop");
  assert.equal(asked.decision, "block");
  assert.match(asked.reason, /^This session is full \(262k of 250k\)\. Write the handoff now\. Reply with only the handoff, at most 60 lines, for the next session: /);
  assert.match(asked.reason, /The router adds the facts itself: open tasks, running Codex jobs and threads, kept worktrees, branch, last commit, uncommitted files\.$/);
  assert.equal(fs.existsSync(path.join(f.data, "handoffs", "s1.json")), false);
  const reply = Array.from({ length: 61 }, (_, i) => `line ${i + 1}`).join("\n");
  const saved = f.hook("Stop", { stop_hook_active: true, last_assistant_message: `\n${reply}\n` });
  assert.deepEqual(saved, { systemMessage: "This session is full (262k of 250k). The handoff is saved. Open a new session in this folder and type continue." });
  const handoff = f.handoff();
  assert.equal(handoff.judgement, reply.split("\n").slice(0, 60).join("\n"));
  assert.deepEqual([handoff.version, handoff.sessionId, handoff.size, handoff.limit, handoff.usedAt, handoff.usedBy, handoff.nextRequests], [1, "s1", 262000, 250000, null, null, []]);
  assert.equal(handoff.project, f.project.replace(/\\/g, "/"));
  assert.equal(handoff.facts.branch, "main");
  assert.match(handoff.facts.lastCommit, /^[0-9a-f]+ base commit$/);
  assert.equal(handoff.facts.uncommitted, "2 files: new1.txt, new2.txt");
  assert.equal(handoff.facts.openTasks, 't2 "Parser" (implement, hard), last: router:sonnet-high fail (verify)');
  assert.equal(handoff.facts.workers, "a1 router:haiku-low t2");
  assert.equal(handoff.facts.codexJobs, 'job1 thread th1 "Parser fix" (process gone)');
  assert.equal(handoff.facts.codexThreads, "th1");
  assert.match(handoff.facts.worktrees, /worker-tree \(w\)$/);
  assert.deepEqual(f.hook("Stop", { stop_hook_active: true, last_assistant_message: "again" }), {});
  assert.deepEqual(f.hook("Stop"), {});
  assert.equal(f.handoff().judgement, handoff.judgement);

  // Without stop_hook_active the second Stop saves too, using the transcript when there is no last message.
  f.size(262000, "written in the transcript");
  assert.equal(f.hook("Stop", { session_id: "s2" }).decision, "block");
  assert.equal(f.hook("Stop", { session_id: "s2" }).systemMessage?.startsWith("This session is full"), true);
  assert.equal(f.handoff("s2").judgement, "written in the transcript");
  assert.deepEqual(f.hook("Stop", { session_id: "s2" }), {});
  // Another plugin's Stop block (stop_hook_active) still gets our single request first.
  assert.equal(f.hook("Stop", { session_id: "s3", stop_hook_active: true, last_assistant_message: "review text" }).decision, "block");
  assert.equal(fs.existsSync(path.join(f.data, "handoffs", "s3.json")), false);
  assert.equal(f.hook("Stop", { session_id: "s3", stop_hook_active: true, last_assistant_message: "the handoff" }).systemMessage?.startsWith("This session is full"), true);
  assert.equal(f.handoff("s3").judgement, "the handoff");
});

test("a prompt in a full session is blocked, kept for the next session and reopens a used handoff", (t) => {
  const f = fixture(t, { setup: false });
  f.size(262000);
  const message = "This session is full (262k of 250k). The handoff is saved. Open a new session in this folder and type continue.";
  assert.deepEqual(f.hook("UserPromptSubmit", { prompt: "do the next thing" }), { decision: "block", reason: message });
  let handoff = f.handoff();
  assert.equal(handoff.judgement, null);
  assert.deepEqual(handoff.nextRequests.map((r) => r.text), ["do the next thing"]);
  assert.equal(handoff.size, 262000);
  assert.equal(f.session().full, true);
  assert.deepEqual(f.hook("UserPromptSubmit", { prompt: "   " }).decision, "block");
  assert.deepEqual(f.hook("UserPromptSubmit", { prompt: "and this" }).decision, "block");
  assert.deepEqual(f.handoff().nextRequests.map((r) => r.text), ["do the next thing", "and this"]);
  // A background-task notice is blocked too, but it is not the owner's next request.
  assert.equal(f.hook("UserPromptSubmit", { prompt: "<task-notification>\n<task-id>a1</task-id>\n</task-notification>" }).decision, "block");
  assert.deepEqual(f.handoff().nextRequests.map((r) => r.text), ["do the next thing", "and this"]);
  fs.writeFileSync(path.join(f.data, "handoffs", "s1.json"), JSON.stringify({ ...f.handoff(), judgement: "kept text", usedAt: "2026-01-01T00:00:00.000Z", usedBy: "s9" }));
  f.hook("UserPromptSubmit", { prompt: "third" });
  handoff = f.handoff();
  assert.deepEqual([handoff.judgement, handoff.usedAt, handoff.usedBy, handoff.nextRequests.length], ["kept text", null, null, 3]);
  // The session stays full even if its transcript is gone.
  fs.rmSync(f.transcript);
  assert.equal(f.hook("UserPromptSubmit", { prompt: "x" }).decision, "block");
});

test("PreCompact is blocked; an automatic compaction marks the session full", (t) => {
  const f = fixture(t, { setup: false });
  f.size(180000);
  const reason = "Compaction is off: this session hands off at 250k instead (now 180k).";
  assert.deepEqual(f.hook("PreCompact", { trigger: "manual" }), { decision: "block", reason });
  assert.equal(f.hook("UserPromptSubmit", { prompt: "go" }).decision, undefined);
  assert.deepEqual(f.hook("PreCompact", { trigger: "auto" }), { decision: "block", reason });
  assert.equal(f.session().full, true);
  assert.deepEqual(f.hook("UserPromptSubmit", { prompt: "go" }),
    { decision: "block", reason: "This session is full (180k of 250k). The handoff is saved. Open a new session in this folder and type continue." });
  assert.deepEqual(f.hook("Stop").decision, "block");
});

test("SessionStart loads the newest unused handoff of the same folder once", (t) => {
  const f = fixture(t, { setup: false });
  const other = path.join(f.home, "other");
  const facts = { time: "2026-02-02T10:00:00.000Z", branch: "dev", lastCommit: "c967839 Router step", uncommitted: "3 files: a, b, c", openTasks: 't2 "Parser" (implement, hard), last: router:sonnet-high fail (verify)',
    workers: "a1 router:haiku-low t2", codexJobs: "none", worktrees: "none", codexThreads: "th1" };
  const make = (id, project, createdAt, extra = {}) => f.write(path.join(f.data, "handoffs", `${id}.json`), { version: 1, sessionId: id, project, createdAt, size: 262000, limit: 250000,
    judgement: `Judgement of ${id}`, facts, nextRequests: [], usedAt: null, usedBy: null, ...extra });
  make("old", f.project, "2026-02-01T10:00:00.000Z");
  make("new", f.project.replace(/\\/g, "/"), "2026-02-02T10:00:00.000Z", { nextRequests: [{ time: "t", text: "fix\nthe  parser" }, { time: "t", text: "then docs" }] });
  make("elsewhere", other, "2026-02-03T10:00:00.000Z");
  make("blank", f.project, "2026-01-01T00:00:00.000Z", { judgement: null, facts: {} });
  f.size(1000);
  assert.equal(f.context("SessionStart", { session_id: "n0", source: "resume" }), undefined);
  assert.equal(f.hook("SessionStart", { session_id: "n0", source: "compact" }).hookSpecificOutput, undefined);
  const text = f.context("SessionStart", { session_id: "n1", source: "startup" });
  assert.equal(text, [
    "Handoff from the previous session (ended at 262k of 250k, 2026-02-02T10:00:00.000Z). Start by saying in 3 lines where things stand, then continue.",
    "Judgement of new",
    "Facts (router, 2026-02-02T10:00:00.000Z):",
    "- Branch: dev · last commit c967839 Router step",
    "- Uncommitted: 3 files: a, b, c",
    '- Open tasks: t2 "Parser" (implement, hard), last: router:sonnet-high fail (verify)',
    "- Claude workers still running: a1 router:haiku-low t2",
    "- Codex jobs running: none",
    "- Kept worktrees: none",
    "- Codex threads of open tasks: th1",
    "Next request (typed in the full session): fix the parser",
    "Next request (typed in the full session): then docs"].join("\n"));
  for (const id of ["new", "old", "blank"]) assert.deepEqual([f.handoff(id).usedBy, typeof f.handoff(id).usedAt], ["n1", "string"], id);
  assert.deepEqual([f.handoff("elsewhere").usedAt, f.handoff("elsewhere").usedBy], [null, null]);
  assert.equal(f.context("SessionStart", { session_id: "n2", source: "clear" }), undefined);
  // The other folder's handoff loads in its own folder, with a clear; a missing judgement says so.
  const there = f.context("SessionStart", { session_id: "n3", source: "clear", cwd: other }, { CLAUDE_PROJECT_DIR: other });
  assert.match(there, /^Handoff from the previous session[^\n]*\nJudgement of elsewhere\n/);
  make("empty", f.project, "2026-03-01T00:00:00.000Z", { judgement: null, facts: {} });
  assert.match(f.context("SessionStart", { session_id: "n4", source: "startup" }),
    /\n\(No written handoff: the session filled up before writing one\.\)\nFacts \(router, unknown\):\n- Branch: unknown · last commit unknown\n- Uncommitted: unknown\n/);
});

test("a resumed full session is told its messages are blocked; old handoffs are deleted", (t) => {
  const f = fixture(t);
  f.size(262000);
  assert.equal(f.context("SessionStart", { source: "resume" }).split("\n").at(-1),
    "This session is full (262k of 250k); new messages are blocked. Open a new session in this folder and type continue.");
  f.write(path.join(f.data, "handoffs", "ancient.json"), { version: 1, project: f.project, createdAt: "2020-01-01T00:00:00.000Z" });
  f.write(path.join(f.data, "handoffs", "recent.json"), { version: 1, project: f.project, createdAt: "2020-01-01T00:00:00.000Z", usedAt: "x" });
  fs.utimesSync(path.join(f.data, "handoffs", "ancient.json"), new Date(Date.now() - 31 * 86400000), new Date(Date.now() - 31 * 86400000));
  f.size(1000);
  f.hook("SessionStart", { session_id: "n9", source: "resume" });
  assert.equal(fs.existsSync(path.join(f.data, "handoffs", "ancient.json")), false);
  assert.equal(fs.existsSync(path.join(f.data, "handoffs", "recent.json")), true);
});

test("protected files and the installed plugin cannot be changed through tools, in every mode", (t) => {
  const f = fixture(t, { setup: false });
  const cache = path.join(f.home, ".claude", "plugins", "cache", "gswitchtool", "router", "0.7.0");
  const reason = "Protected: the router's settings, session and handoff files and the installed plugin change only through GSwitch and the router. Change settings in GSwitch → Claude Code.";
  const pre = (tool_name, tool_input, extra = {}) => f.hook("PreToolUse", { tool_name, tool_input, ...extra });
  const modes = [() => fs.rmSync(f.setupFile, { force: true }), () => f.setup(), () => f.setup({ router: { mode: "mixed", claudeOnlyReview: "off" } })];
  for (const mode of modes) {
    mode();
    for (const [tool, key] of [["Edit", "file_path"], ["Write", "file_path"], ["MultiEdit", "file_path"], ["NotebookEdit", "notebook_path"]]) {
      for (const file of [f.setupFile, path.join(f.data, "handoffs", "a.json"), path.join(f.data, "sessions", "s1.json"), path.join(cache, "scripts", "router.mjs"),
        path.join(f.home, ".claude", "plugins", "marketplaces", "m", "x.md"), path.join(f.data, "..", ".gswitchtool-router", "config.json")]) {
        assert.equal(f.reason(pre(tool, { [key]: file })), reason, `${tool} ${file}`);
      }
    }
    assert.equal(f.reason(pre("Edit", { file_path: path.join(f.data, "x.json") }, { agent_id: "a1" })), reason);
    assert.equal(f.reason(pre("Edit", { file_path: ".gswitchtool/claude-setup.json" }, { cwd: f.home })), reason);
    assert.deepEqual(pre("Write", { file_path: path.join(f.project, "src", "a.js") }), {});
    assert.deepEqual(pre("Edit", { file_path: path.join(f.home, ".claude", "plugins", "other", "a.js") }), {});
    for (const [tool, command] of [
      ["Bash", "echo x > ~/.gswitchtool-router/handoffs/a.json"],
      ["Bash", `echo x > "${f.data}/handoffs/a.json"`],
      ["Bash", "cat $HOME/.gswitchtool/claude-setup.json"],
      ["Bash", "rm -rf ${HOME}/.claude/plugins/cache"],
      ["Bash", "cp x %USERPROFILE%\\.claude\\plugins\\marketplaces\\m"],
      ["Bash", `node "${cache}/scripts/router.mjs" plan s1 p && rm ~/.gswitchtool-router/results.jsonl`],
      ["Bash", "node -e \"require('fs').rmSync(process.env.HOME + '/.gswitchtool-router', {recursive: true})\""],
      ["PowerShell", "Remove-Item $env:USERPROFILE\\.gswitchtool-router\\sessions\\x.json"],
      ["PowerShell", "Set-Content -Path ~\\.gswitchtool\\claude-setup.json -Value x"],
      ["PowerShell", `Get-Content C:\\Users\\me\\${process.platform === "win32" ? ".CLAUDE\\plugins\\Cache" : ".claude\\plugins\\cache"}\\x.json`]]) {
      assert.equal(f.reason(pre(tool, { command })), reason, command);
      assert.equal(f.reason(pre(tool, { command }, { agent_id: "a1" })), reason, command);
    }
    for (const [tool, command] of [
      ["Bash", "git status"],
      ["Bash", `node "${cache}/scripts/router.mjs" plan s1 "${f.project}" --task t1 --kind implement --difficulty small`],
      ["Bash", `cd "${f.project}" && node "${cache.replace(/\\/g, "/")}/scripts/router.mjs" mode s1 .`],
      ["Bash", `node "${path.join(f.home, ".claude", "plugins", "cache", "codex", "codex", "1.0", "scripts", "codex-companion.mjs")}" invoke-run --model m --effort low "brief"`],
      ["Bash", `node.exe "${f.home}/.claude/plugins/cache/c/codex-companion.mjs" invoke-status`],
      ["PowerShell", "Get-ChildItem src"]]) {
      assert.deepEqual(pre(tool, { command }), {}, command);
    }
  }
});

test("the released plugin leaves limit, handoff and protection to router-dev in a Dev test session", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, ".gswitchtool-dev", "dev-sessions"), { recursive: true });
  f.size(262000);
  const pre = (tool_name, tool_input) => f.hook("PreToolUse", { tool_name, tool_input });
  const guarded = () => [f.hook("UserPromptSubmit", { prompt: "go" }).decision, f.hook("Stop").decision, f.hook("PreCompact", { trigger: "auto" }).decision,
    !!f.reason(pre("Agent", { subagent_type: "router:haiku-low", prompt: "x" }))?.startsWith("Session"), f.denied(pre("Write", { file_path: f.setupFile })),
    f.denied(pre("Bash", { command: "cat ~/.gswitchtool-router/x" })), !!f.context("SessionStart", { source: "resume" })?.includes("is full")];
  assert.deepEqual(guarded(), ["block", "block", "block", true, true, true, true]);
  fs.rmSync(f.data, { recursive: true, force: true });
  fs.writeFileSync(path.join(f.home, ".gswitchtool-dev", "dev-sessions", "s1"), "");
  assert.deepEqual(guarded(), [undefined, undefined, undefined, false, false, false, false]);
  assert.equal(fs.existsSync(path.join(f.data, "handoffs")), false);
});

test("wrapup is gone", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [script, "wrapup", "show", f.project], { cwd: f.home, env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /Unknown router command/);
  assert.doesNotMatch(f.context("SessionStart", { source: "startup" }) ?? "", /wrapup/);
  assert.doesNotMatch(fs.readFileSync(script, "utf8"), /wrapup/i);
});
