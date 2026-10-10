// Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { invokeOutcome, recordInvoke } from "../plugins/codex/scripts/lib/invoke-record.mjs";
import { briefHeaders, invokeSummary, parseReviewLine } from "../plugins/codex/scripts/lib/invoke-summary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const TOKEN = "runner-token";
const SESSION = "session-1";
const ROUTER_SETUP = { version: 1, setup: "router", router: { mode: "mixed", claudeOnlyReview: "off" } };

// A GSwitch that allows model-a only and can be paused.
async function startFakeGSwitch({ paused = null, setup = ROUTER_SETUP } = {}) {
  const configDir = makeTempDir("gswitch-config-");
  const endpoint = process.platform === "win32"
    ? path.join("\\\\.\\pipe", `gswitch-runner-${randomUUID()}`)
    : path.join(configDir, "invoke.sock");
  const respond = (request) => {
    const ok = (result = {}) => ({ id: request.id, result });
    const fail = (code, detail) => ({ id: request.id, error: { code, ...(detail ? { detail } : {}) } });
    if (request.token !== TOKEN) return fail("UNAUTHORIZED");
    switch (request.method) {
      case "lease_open":
        if (paused) return fail("INVOKE_PAUSED", String(paused.resumes_at ?? ""));
        if (request.params.model !== "model-a") return fail("MODEL_NOT_ALLOWED");
        return ok({ lease_id: "lease-1", codex_home: path.join(configDir, "codex-home") });
      case "run_begin": return ok({ service_tier: "default", speed: "normal", speed_note: null });
      case "run_end": return ok({ outcome: "unchanged" });
      default: return ok();
    }
  };
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        socket.write(`${JSON.stringify(respond(request))}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  fs.writeFileSync(path.join(configDir, "invoke-endpoint.json"), JSON.stringify({ endpoint, token: TOKEN, pid: process.pid }));
  if (setup) fs.writeFileSync(path.join(configDir, "claude-setup.json"), JSON.stringify(setup));
  return { configDir, close: () => new Promise((resolve) => server.close(resolve)) };
}

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, routerDir: makeTempDir("router-data-") };
}

function companion(args, { repo, binDir, configDir, routerDir }, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env: {
        ...buildEnv(binDir), GSWITCH_CONFIG_DIR: configDir, CLAUDE_PLUGIN_DATA: path.join(configDir, "plugin-data"),
        GSWITCH_ROUTER_DATA_DIR: routerDir, CLAUDE_CODE_SESSION_ID: SESSION, ...env
      },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function withGSwitch(options, behavior, body) {
  const gswitch = await startFakeGSwitch(options);
  try {
    await body({ ...setupRepo(behavior), configDir: gswitch.configDir });
  } finally {
    await gswitch.close();
  }
}

const INVOKE = ["--model", "model-a", "--effort", "high"];
const lastLines = (text, count = 3) => text.trimEnd().split(/\r?\n/).slice(-count);
const resultsFile = (ctx) => path.join(ctx.routerDir, "results.jsonl");
const readRecords = (ctx) => fs.existsSync(resultsFile(ctx))
  ? fs.readFileSync(resultsFile(ctx), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
const appendPlan = (ctx, plan) => fs.writeFileSync(resultsFile(ctx), `${JSON.stringify({ type: "plan", sessionId: SESSION, task: "t1", difficulty: "hard", title: "Plan title", ...plan })}\n`, { flag: "a" });

test("a passing write run ends with the CODEX, CHECK and ANSWER lines and saves its full output", () =>
  withGSwitch({}, "invoke-write", async (ctx) => {
    const result = await companion(["invoke", ...INVOKE, "--write", "--verify", "node --version", "TASK: t1\nDIFFICULTY: small\nchange a file"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const [codex, check, answer] = lastLines(result.stdout);
    assert.match(codex, /^CODEX: completed · task t1 · model-a\/high · write · thread \S+ · job task-\S+$/);
    assert.match(check, /^CHECK: Verify passed \(\d+s\) · 1 files \+2 −0: outside\.ts · 0 warnings · 0 scope requests$/);
    assert.match(answer, /^ANSWER: Changed: outside\.ts — added fixture changes · full: .+\.result\.txt$/);
    const full = answer.split(" · full: ")[1];
    assert.equal(fs.readFileSync(full, "utf8"), result.stdout, "the saved file is the whole output");
    assert.match(result.stdout, /\[codex invoke\] completed/);
  }));

test("--json carries the same 3 summary lines", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", "--json", ...INVOKE, "TASK: t1\nlook around"], ctx);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.length, 3);
    assert.match(payload.summary[0], /^CODEX: completed · task t1 · model-a\/high · thread \S+ · job task-\S+$/);
    assert.match(payload.summary[2], /^ANSWER: Handled the requested task\. · full: /);
  }));

test("a verify failure shows in the CHECK line", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", ...INVOKE, "--verify", "node -e \"process.exit(4)\"", "TASK: t1\nDIFFICULTY: small\ndo it"], ctx);
    assert.equal(result.status, 3, result.stderr);
    assert.match(lastLines(result.stdout)[1], /^CHECK: Verify FAILED after 1 retry \(exit 4\) · 0 files \+0 −0 · 0 warnings · 0 scope requests$/);
  }));

test("a rejected model gets a NEXT line and no job", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", "--model", "model-z", "--effort", "high", "TASK: t1\nDIFFICULTY: small\ndo it"], ctx);
    assert.equal(result.status, 2);
    const [codex, check, next] = lastLines(result.stdout);
    assert.equal(codex, "CODEX: rejected (MODEL_NOT_ALLOWED) · task t1 · model-z/high · thread - · job -");
    assert.equal(check, "CHECK: Verify none · 0 files +0 −0 · 0 warnings · 0 scope requests");
    assert.equal(next, "NEXT: choose an allowed model from the Router line, then run again.");
  }));

test("a pause gives the PAUSE ALL WORK instruction and the reset time within 400 characters", () =>
  withGSwitch({ paused: { resumes_at: Math.floor(Date.now() / 1000) + 2 * 3600 } }, undefined, async (ctx) => {
    const result = await companion(["invoke", ...INVOKE, "TASK: t1\nDIFFICULTY: small\ndo it"], ctx);
    const lines = lastLines(result.stdout);
    assert.match(lines[0], /^CODEX: rejected \(INVOKE_PAUSED\) · task t1 /);
    assert.match(lines[2], /^NEXT: PAUSE ALL WORK: stop now\..*\(Codex usage resets around .*\)$/);
    for (const line of lines) assert.ok(line.length <= 400, line);
  }));

test("a read-only review run names the review verdict and findings", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", ...INVOKE, "REVIEWS: t1\nreview it"], ctx, { GSWITCH_TEST_ANSWER: "Two things.\nREVIEW: minor · findings: 2" });
    assert.equal(result.status, 0, result.stderr);
    const [codex, , review] = lastLines(result.stdout);
    assert.match(codex, /^CODEX: completed · task t1 · model-a\/high · thread/);
    assert.match(review, /^REVIEW: minor · findings 2 · full: .+\.result\.txt$/);
    assert.deepEqual(readRecords(ctx).map(({ type, task, reviewer, review: verdict, findings }) => ({ type, task, reviewer, review: verdict, findings })),
      [{ type: "review", task: "t1", reviewer: "codex:model-a/high", review: "minor", findings: 2 }]);
  }));

test("briefHeaders and parseReviewLine read the router's lines", () => {
  assert.deepEqual(briefHeaders("TASK: t-1.a\nKIND: build\nDIFFICULTY: high-risk\ntext"), { task: "t-1.a", reviews: null, kind: "build", difficulty: "high-risk" });
  assert.deepEqual(briefHeaders("REVIEWS: t2\r\nbody TASK: x"), { task: null, reviews: "t2", kind: null, difficulty: null });
  assert.equal(briefHeaders("TASK: has space\n").task, null);
  assert.deepEqual(parseReviewLine("a\nREVIEW: none · findings: 0\nREVIEW: serious · findings: 120\n"), { review: "serious", findings: null });
  assert.deepEqual(parseReviewLine("REVIEW: none · findings: 0\nbye"), { review: "none", findings: 0 });
  assert.deepEqual(parseReviewLine("nothing"), { review: null, findings: null });
});

test("the summary keeps every line under 400 characters and names scope requests, warnings and the kept worktree", () => {
  const lines = invokeSummary({
    status: "completed", code: null, model: "m", reasoningEffort: "high", write: true, threadId: "t", jobId: "j", failovers: 2,
    verify: { passed: true, retries: 1, durationSeconds: 3 }, diff: { repository: true, totalFiles: 5, added: 9, deleted: 1, files: ["a", "b", "c", "d"].map((p) => ({ path: p })) },
    warnings: ["WARNING: changed outside --scope: x", "WARNING: second"], scopeRequests: [{ path: "p/q" }],
    worktree: { applied: false, keptAt: "C:/wt", reason: "x".repeat(900) }, output: "ignored"
  }, { task: "t1", fullFile: "F" });
  assert.equal(lines[0], "CODEX: completed · task t1 · m/high · write · thread t · job j · resumed after 2 account switches");
  assert.equal(lines[1], "CHECK: Verify passed after 1 retry · 5 files +9 −1: a, b, c · 2 warnings: changed outside --scope: x · 1 scope requests: p/q");
  assert.match(lines[2], /^NEXT: worktree kept at C:\/wt \(x+…?\)/);
  for (const line of lines) assert.ok(line.length <= 400);
});

test("invoke outcomes follow what invoke itself saw", () => {
  const completed = { status: "completed", write: true, diff: { repository: true, files: [{ path: "a" }] } };
  const cases = [
    [{ ...completed, verify: { passed: true } }, ["pass", null]],
    [completed, ["unverified", null]],
    [{ ...completed, write: false, diff: { repository: true, files: [] } }, ["unverified", null]],
    [{ ...completed, diff: { repository: true, files: [] } }, ["fail", "incomplete"]],
    [{ ...completed, verify: { passed: false } }, ["fail", "verify"]],
    [{ ...completed, scopeStopped: true }, ["fail", "scope"]],
    [{ ...completed, protected: { changed: ["p"] } }, ["fail", "other"]],
    [{ ...completed, worktree: { applied: false, keptAt: "w" } }, ["fail", "worktree"]],
    [{ status: "failed", code: "CODEX_FAILED" }, ["fail", "tool"]],
    [{ status: "failed", code: "USAGE_LIMIT_EXCEEDED" }, ["fail", "usage"]],
    [{ status: "failed", code: "STOPPED_BY_USER" }, ["fail", "stopped"]],
    [{ status: "rejected", code: "NO_ELIGIBLE_ACCOUNT" }, ["fail", "usage"]],
    [{ status: "rejected", code: "INVOKE_PAUSED" }, ["fail", "usage"]],
    [{ status: "rejected", code: "MODEL_NOT_ALLOWED" }, ["blocked", "tool"]],
    [{ status: "rejected", code: "CODEX_SIGNED_OUT" }, ["blocked", "tool"]]
  ];
  for (const [result, expected] of cases) assert.deepEqual(invokeOutcome(result), expected, JSON.stringify(result));
});

test("a result record carries the right worker, project, outcome, step and difficulty from the header", () =>
  withGSwitch({}, "invoke-write", async (ctx) => {
    const result = await companion(["invoke", ...INVOKE, "--write", "--verify", "node --version", "TASK: t1\nDIFFICULTY: small\nchange a file"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const [record, ...rest] = readRecords(ctx);
    assert.deepEqual(rest, []);
    const [, thread, job] = lastLines(result.stdout)[0].match(/thread (\S+) · job (\S+)/);
    const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.repo }).stdout.trim().replace(/\\/g, "/");
    assert.match(record.time, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual({ ...record, time: undefined }, {
      type: "result", time: undefined, sessionId: SESSION, project: repoRoot, task: "t1", difficulty: "small", worker: "codex:model-a/high",
      outcome: "pass", reason: null, step: "start", title: null, agentId: null, codexJobId: job, codexThreadId: thread,
      review: null, findings: null, sample: false, source: "invoke"
    });
  }));

test("difficulty, title and sample come from the plan; later runs are escalations or repairs", () =>
  withGSwitch({}, undefined, async (ctx) => {
    appendPlan(ctx, { sample: "codex:model-a/high" });
    appendPlan(ctx, { task: "other", difficulty: "trivial", title: "Not this one" });
    const first = await companion(["invoke", ...INVOKE, "TASK: t1\nresearch it"], ctx);
    assert.equal(first.status, 0, first.stderr);
    const second = await companion(["invoke", ...INVOKE, "TASK: t1\nresearch it again"], ctx);
    const thread = lastLines(second.stdout)[0].match(/thread (\S+)/)[1];
    await companion(["invoke", ...INVOKE, "--resume-thread", thread, "TASK: t1\nfix it"], ctx);
    const results = readRecords(ctx).filter((record) => record.type === "result");
    assert.deepEqual(results.map(({ difficulty, title, step, sample, outcome }) => ({ difficulty, title, step, sample, outcome })), [
      { difficulty: "hard", title: "Plan title", step: "start", sample: true, outcome: "unverified" },
      { difficulty: "hard", title: "Plan title", step: "escalation", sample: false, outcome: "unverified" },
      { difficulty: "hard", title: "Plan title", step: "repair", sample: false, outcome: "unverified" }
    ]);
  }));

test("failed and refused runs are recorded with their reason", async () => {
  await withGSwitch({}, undefined, async (ctx) => {
    await companion(["invoke", ...INVOKE, "--verify", "node -e \"process.exit(1)\"", "TASK: t1\nDIFFICULTY: small\ndo it"], ctx);
    await companion(["invoke", "--model", "model-z", "--effort", "high", "TASK: t2\nDIFFICULTY: small\ndo it"], ctx);
    assert.deepEqual(readRecords(ctx).map(({ task, outcome, reason }) => ({ task, outcome, reason })), [
      { task: "t1", outcome: "fail", reason: "verify" },
      { task: "t2", outcome: "blocked", reason: "tool" }
    ]);
  });
  await withGSwitch({ paused: { resumes_at: null } }, undefined, async (ctx) => {
    await companion(["invoke", ...INVOKE, "TASK: t1\nDIFFICULTY: small\ndo it"], ctx);
    assert.deepEqual(readRecords(ctx).map(({ outcome, reason }) => ({ outcome, reason })), [{ outcome: "fail", reason: "usage" }]);
  });
});

test("nothing is recorded outside the router setup, without a session id, a difficulty or a task", async () => {
  const brief = "TASK: t1\nDIFFICULTY: small\ndo it";
  for (const [options, env, prompt] of [
    [{ setup: { ...ROUTER_SETUP, setup: "claude-codex" } }, {}, brief],
    [{ setup: { ...ROUTER_SETUP, router: { ...ROUTER_SETUP.router, mode: "off" } } }, {}, brief],
    [{ setup: null }, {}, brief],
    [{}, { CLAUDE_CODE_SESSION_ID: "" }, brief],
    [{}, {}, "TASK: t1\nno difficulty anywhere"],
    [{}, {}, "DIFFICULTY: small\nno task id"]
  ]) {
    await withGSwitch(options, undefined, async (ctx) => {
      const result = await companion(["invoke", ...INVOKE, prompt], ctx, env);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readRecords(ctx), [], JSON.stringify([options, env, prompt]));
    });
  }
});

test("a Dev plugin records its worker as codex-dev and a failing log never breaks the run", async () => {
  const configDir = makeTempDir("gswitch-config-");
  const routerDir = makeTempDir("router-data-");
  fs.writeFileSync(path.join(configDir, "claude-setup.json"), JSON.stringify(ROUTER_SETUP));
  const env = { GSWITCH_CONFIG_DIR: configDir, GSWITCH_ROUTER_DATA_DIR: routerDir, CLAUDE_CODE_SESSION_ID: SESSION };
  const result = { status: "completed", model: "model-a", reasoningEffort: "high", write: false, jobId: "j", threadId: "t", output: "ok" };
  recordInvoke({ result, headers: { task: "t1", reviews: null, difficulty: "hard" }, cwd: configDir, pluginName: "codex-dev" }, env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(routerDir, "results.jsonl"), "utf8")).worker, "codex-dev:model-a/high");
  fs.writeFileSync(path.join(routerDir, "blocked"), "x");
  recordInvoke({ result, headers: { task: "t1", reviews: null, difficulty: "hard" }, cwd: configDir }, { ...env, GSWITCH_ROUTER_DATA_DIR: path.join(routerDir, "blocked", "sub") });
});

test("invoke-run prints only the 3 summary lines of a quick run and keeps invoke's exit code", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke-run", ...INVOKE, "--verify", "node -e \"process.exit(2)\"", "--wait-seconds", "60", "TASK: t1\nDIFFICULTY: small\ndo it"], ctx);
    assert.equal(result.status, 3, result.stderr);
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^CODEX: completed · task t1 · model-a\/high · thread \S+ · job task-\S+$/);
    assert.match(lines[1], /^CHECK: Verify FAILED after 1 retry \(exit 2\)/);
    assert.equal(readRecords(ctx).length, 1, "the detached invoke recorded its result once");
  }));

test("invoke-run answers RUNNING for a slow run, invoke-wait finishes it, and a lost run is reported", () =>
  withGSwitch({}, "interruptible-slow-task", async (ctx) => {
    const started = await companion(["invoke-run", ...INVOKE, "--wait-seconds", "1", "TASK: t1\nDIFFICULTY: small\nslow"], ctx);
    assert.equal(started.status, 75, started.stderr);
    const [, runId] = started.stdout.match(/^RUNNING: (run-\S+) · next: node "(.+)" invoke-wait \1$/m);
    assert.ok(started.stdout.includes(`node "${SCRIPT}" invoke-wait ${runId}`));

    const finished = await companion(["invoke-wait", runId, "--wait-seconds", "60"], ctx);
    assert.equal(finished.status, 0, finished.stderr);
    assert.match(finished.stdout, /^CODEX: completed · task t1 .*\nCHECK: .*\nANSWER: /);
    assert.equal(finished.stdout.trimEnd().split("\n").length, 3);

    const unknown = await companion(["invoke-wait", "run-nope"], ctx);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr.trimEnd().split("\n").length, 1);

    const second = await companion(["invoke-run", ...INVOKE, "--wait-seconds", "0", "TASK: t2\nDIFFICULTY: small\nslow"], ctx);
    assert.equal(second.status, 75);
    const lostId = second.stdout.match(/RUNNING: (run-\S+)/)[1];
    const stateRoot = path.join(ctx.configDir, "plugin-data", "state");
    const metaFile = fs.readdirSync(stateRoot).map((dir) => path.join(stateRoot, dir, "jobs", `${lostId}.run.json`)).find((file) => fs.existsSync(file));
    const pid = JSON.parse(fs.readFileSync(metaFile, "utf8")).pid;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
    const lost = await companion(["invoke-wait", lostId, "--wait-seconds", "30"], ctx);
    assert.equal(lost.status, 1);
    const lines = lost.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^CODEX: failed \(RUNNER_LOST\)/);
    assert.match(lines[2], /^NEXT: .*\.run\.txt/);
  }));

test("invoke-run reports an error from invoke itself in the same 3-line shape", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke-run", "--model", "model-a", "do it"], ctx);
    assert.equal(result.status, 1);
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^CODEX: failed \(INVOKE_ERROR\)/);
    assert.match(lines[2], /^NEXT: tell the user: invoke requires --model and --effort/);
  }));
