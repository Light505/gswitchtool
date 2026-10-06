// Added by Light505 for gswitchtool (2026): tests for the invoke and invoke-status commands. See CREDITS.md in gswitchtool.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const TOKEN = "launch-token";
const PROFILES = [
  { model: "model-a", reasoning_efforts: ["high", "xhigh"] },
  { model: "model-b", reasoning_efforts: ["medium"] }
];
const FAILOVER_RESUME_PROMPT =
  "Authentication changed because the previous Codex account reached its usage limit. Resume this existing thread and continue the task from where it stopped. Inspect the current working-tree state before continuing and do not redo completed work.";

// Answers like GSwitch's Invoke endpoint from an in-memory policy. A failover
// "succeeds" unless failoverError is set; the fake does not switch accounts.
async function startFakeGSwitch({
  invokeMode = true,
  failoverError = null,
  manualAfterLease = false,
  waitingForCodex = false,
  failoverDetail = null,
  paused = null,
  maxTasks = null
} = {}) {
  const configDir = makeTempDir("gswitch-config-");
  const endpoint =
    process.platform === "win32"
      ? path.join("\\\\.\\pipe", `gswitch-test-${randomUUID()}`)
      : path.join(configDir, "invoke.sock");
  const requests = [];
  const policy = { invokeMode };
  const respond = (request) => {
    const fail = (code) => ({ id: request.id, error: { code } });
    const ok = (result = {}) => ({ id: request.id, result });
    if (request.token !== TOKEN) return fail("UNAUTHORIZED");
    switch (request.method) {
      case "status":
        return ok({
          invoke_mode: policy.invokeMode,
          allowed_invocation_profiles: policy.invokeMode ? PROFILES : [],
          workers_running: 0,
          failover_in_progress: waitingForCodex,
          ...(waitingForCodex ? { waiting_for_codex_to_close: true } : {}),
          ...(paused ? { paused } : {}),
          ...(maxTasks ? { max_concurrent_tasks: maxTasks } : {})
        });
      case "lease_open": {
        if (!policy.invokeMode) return fail("INVOKE_MODE_DISABLED");
        if (paused) {
          return { id: request.id, error: { code: "INVOKE_PAUSED", detail: String(paused.resumes_at ?? "") } };
        }
        const profile = PROFILES.find((entry) => entry.model === request.params.model);
        if (!profile) return fail("MODEL_NOT_ALLOWED");
        if (!profile.reasoning_efforts.includes(request.params.reasoning_effort)) return fail("REASONING_NOT_ALLOWED");
        if (manualAfterLease) policy.invokeMode = false;
        return ok({ lease_id: "lease-1" });
      }
      case "run_begin":
      case "run_app_server":
      case "run_thread":
        return ok();
      case "run_end":
        return ok({ outcome: "unchanged" });
      case "limit_reached":
        return policy.invokeMode ? ok({ failover: "started" }) : fail("INVOKE_MODE_DISABLED");
      case "await_failover":
        if (!failoverError) return ok();
        return failoverDetail
          ? { id: request.id, error: { code: failoverError, detail: failoverDetail } }
          : fail(failoverError);
      default:
        return fail("UNKNOWN_METHOD");
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
        requests.push(request);
        socket.write(`${JSON.stringify(respond(request))}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  fs.writeFileSync(path.join(configDir, "invoke-endpoint.json"), JSON.stringify({ endpoint, token: TOKEN, pid: process.pid }));
  return {
    configDir,
    requests,
    methods: () => requests.map((request) => request.method),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, statePath: path.join(binDir, "fake-codex-state.json") };
}

// Asynchronous so the in-process fake GSwitch can answer while it runs.
function companion(args, { repo, binDir, configDir, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env: { ...buildEnv(binDir), GSWITCH_CONFIG_DIR: configDir, ...env },
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
    await body({ ...setupRepo(behavior), configDir: gswitch.configDir }, gswitch);
  } finally {
    await gswitch.close();
  }
}

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

test("invoke-status reports the allowed profiles while Invoke Mode is on", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const json = await companion(["invoke-status", "--json"], ctx);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      available: true,
      invoke_mode: true,
      allowed_invocation_profiles: PROFILES,
      workers_running: 0,
      failover_in_progress: false
    });
    assert.equal(gswitch.requests[0].token, TOKEN);

    const text = await companion(["invoke-status"], ctx);
    assert.match(text.stdout, /- model-a: high, xhigh/);
    assert.match(text.stdout, /- model-b: medium/);
  }));

test("invoke-status tells Claude how many Codex tasks GSwitch runs at once", () =>
  withGSwitch({ maxTasks: 3 }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /GSwitch runs at most 3 Codex tasks at once; more wait their turn./);
  }));

test("invoke-status tells Claude not to delegate in Manual Mode", () =>
  withGSwitch({ invokeMode: false }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Invoke Mode is off in GSwitch/);
  }));

test("invoke-status tells Claude to ask the user to close Codex while a switch waits", () =>
  withGSwitch({ waitingForCodex: true }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /waiting for the user to close Codex/);
  }));

test("invoke-status tells Claude to pause all work while Invoke Mode is paused", () =>
  withGSwitch({ paused: { resumes_at: Math.floor(Date.now() / 1000) + 2 * 3600 } }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Invoke Mode is paused/);
    assert.match(result.stdout, /Codex usage resets around .* \(in about (1 h 59 min|2 h)\)/);
    assert.match(result.stdout, /PAUSE ALL WORK/);
    assert.doesNotMatch(result.stdout, /model-a/, "a paused status offers nothing to choose");
  }));

test("invoke is refused without starting Codex while Invoke Mode is paused", () =>
  withGSwitch({ paused: { resumes_at: null } }, undefined, async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "INVOKE_PAUSED");
    assert.match(payload.message, /No reset time is known/);
    assert.match(payload.message, /PAUSE ALL WORK/);
    assert.equal(fs.existsSync(ctx.statePath), false, "Codex never started");
  }));

test("invoke-status and invoke report GSwitch as unavailable when it is not running", async () => {
  const ctx = { ...setupRepo(), configDir: makeTempDir("gswitch-config-") };
  const status = await companion(["invoke-status", "--json"], ctx);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).code, "GSWITCH_UNAVAILABLE");

  const invoke = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "go"], ctx);
  assert.equal(invoke.status, 2);
  assert.equal(JSON.parse(invoke.stdout).code, "GSWITCH_UNAVAILABLE");
  assert.equal(fs.existsSync(ctx.statePath), false, "Codex must not start without GSwitch");
});

test("invoke refuses a disallowed model, effort, or Manual Mode before starting Codex", async () => {
  for (const [invokeMode, model, effort, code] of [
    [true, "model-z", "high", "MODEL_NOT_ALLOWED"],
    [true, "model-b", "high", "REASONING_NOT_ALLOWED"],
    [false, "model-a", "high", "INVOKE_MODE_DISABLED"]
  ]) {
    await withGSwitch({ invokeMode }, undefined, async (ctx) => {
      const result = await companion(["invoke", "--json", "--model", model, "--effort", effort, "do the work"], ctx);
      assert.equal(result.status, 2, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "rejected");
      assert.equal(payload.code, code);
      assert.equal(fs.existsSync(ctx.statePath), false, "Codex must not start for a rejected request");
    });
  }
});

test("invoke requires Claude to choose both a model and an effort", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const result = await companion(["invoke", "--model", "model-a", "do the work"], ctx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invoke requires --model and --effort/);
    assert.equal(gswitch.requests.length, 0);
  }));

test("invoke registers its run with GSwitch and runs with the chosen settings", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const result = await companion(
      ["invoke", "--json", "--model", "model-a", "--effort", "xhigh", "--write", "implement the feature"],
      ctx
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "progress stays out of the invoking model's output");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.code, null);
    assert.equal(payload.failovers, 0);
    assert.match(payload.jobId, /^task-/);

    assert.deepEqual(gswitch.methods(), ["lease_open", "run_begin", "run_app_server", "run_thread", "run_end"]);
    const [lease, , appServer, thread] = gswitch.requests;
    assert.equal(lease.params.model, "model-a");
    assert.equal(lease.params.reasoning_effort, "xhigh");
    assert.equal(lease.params.write, true);
    assert.ok(Number.isInteger(appServer.params.pid) && appServer.params.pid > 0);
    assert.equal(thread.params.thread_id, payload.threadId);

    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.lastTurnStart.model, "model-a");
    assert.equal(fakeState.lastTurnStart.effort, "xhigh");
    assert.equal(fakeState.lastTurnStart.prompt, "implement the feature");
    assert.equal(fakeState.lastThreadRequest.sandbox, "workspace-write");
    assert.equal(loadBrokerSession(ctx.repo), null, "invoke workers do not use the shared broker");
  }));

test("invoke output is Codex's answer plus one resume line", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", "--model", "model-b", "--effort", "medium", "review the change"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    assert.match(lines.at(-1), /^\[codex invoke\] completed · thread \S+ · job task-\S+ · model-b\/medium$/);
    assert.equal(readFakeState(ctx.statePath).lastThreadRequest.sandbox, "read-only");
  }));

test("invoke --resume-thread continues the named thread", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const first = JSON.parse(
      (await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "first task"], ctx)).stdout
    );
    await companion(["invoke", "--json", "--model", "model-b", "--effort", "medium", "second task"], ctx);

    const resumed = await companion(
      ["invoke", "--json", "--model", "model-a", "--effort", "high", "--resume-thread", first.threadId, "keep going"],
      ctx
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).threadId, first.threadId);
    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.lastThreadRequest.method, "thread/resume");
    assert.equal(fakeState.lastTurnStart.threadId, first.threadId);
    assert.equal(fakeState.threads.length, 2);
  }));

test("after GSwitch switches accounts, invoke resumes the same thread with the same settings", () =>
  withGSwitch({}, "usage-limit-once", async (ctx, gswitch) => {
    const result = await companion(
      ["invoke", "--json", "--model", "model-a", "--effort", "xhigh", "--write", "implement the feature"],
      ctx
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.failovers, 1);

    assert.deepEqual(gswitch.methods(), [
      "lease_open",
      "run_begin",
      "run_app_server",
      "run_thread",
      "run_end",
      "limit_reached",
      "await_failover",
      "run_begin",
      "run_app_server",
      "run_end"
    ]);
    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.threads.length, 1, "the failover must not create a new Codex thread");
    assert.equal(fakeState.turns.length, 2);
    const [first, second] = fakeState.turns;
    assert.equal(first.prompt, "implement the feature");
    assert.equal(second.prompt, FAILOVER_RESUME_PROMPT);
    assert.equal(second.threadId, first.threadId);
    assert.equal(payload.threadId, first.threadId);
    assert.deepEqual([second.model, second.effort], ["model-a", "xhigh"]);
    assert.equal(fakeState.lastThreadRequest.method, "thread/resume");
    assert.equal(fakeState.lastThreadRequest.sandbox, "workspace-write");
    assert.match(result.stdout, /"failovers": 1/);
  }));

test("a failover GSwitch cannot complete is reported with the thread kept", () =>
  withGSwitch({ failoverError: "NO_ELIGIBLE_ACCOUNT" }, "usage-limit-once", async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(payload.code, "NO_ELIGIBLE_ACCOUNT");
    assert.match(payload.message, /PAUSE ALL WORK/);
    assert.ok(payload.threadId);
    assert.equal(readFakeState(ctx.statePath).turns.length, 1, "nothing resumes without a verified switch");
  }));

test("switching GSwitch to Manual Mode stops automatic failover", () =>
  withGSwitch({ manualAfterLease: true }, "usage-limit-once", async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "INVOKE_MODE_DISABLED");
    assert.ok(payload.threadId);
    assert.equal(readFakeState(ctx.statePath).turns.length, 1);
  }));

test("invoke gives up with USAGE_LIMIT_EXCEEDED after repeated failovers", () =>
  withGSwitch({}, "usage-limit", async (ctx, gswitch) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "USAGE_LIMIT_EXCEEDED");
    assert.match(payload.message, /4 accounts in a row\. PAUSE ALL WORK/);
    assert.equal(payload.failovers, 3);
    assert.equal(gswitch.methods().filter((method) => method === "limit_reached").length, 3);
    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.threads.length, 1);
    assert.equal(fakeState.turns.length, 4);
  }));

test("the acceptance switch reports one usage limit after a finished turn", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const result = await companion(
      ["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "do the work"],
      { ...ctx, env: { GSWITCH_INVOKE_SIMULATE_USAGE_LIMIT: "1" } }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.failovers, 1);
    assert.equal(gswitch.methods().filter((method) => method === "limit_reached").length, 1);
    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.threads.length, 1);
    assert.deepEqual(fakeState.turns.map((turn) => turn.prompt), ["do the work", FAILOVER_RESUME_PROMPT]);
  }));

test("a refused switch reports GSwitch's reason and does not resume", () =>
  withGSwitch(
    { failoverError: "ACCOUNT_SWITCH_FAILED", failoverDetail: "recovery_required" },
    "usage-limit-once",
    async (ctx) => {
      const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
      assert.equal(result.status, 1);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.code, "ACCOUNT_SWITCH_FAILED");
      assert.equal(payload.detail, "recovery_required");
      assert.match(payload.message, /GSwitch reason: recovery_required/);
      assert.ok(payload.threadId);
      assert.equal(readFakeState(ctx.statePath).turns.length, 1, "nothing resumes after a refused switch");
    }
  ));

test("Codex delegation is explicit while GSwitch reviews may be chosen by Claude", () => {
  const skill = (name) =>
    fs.readFileSync(path.join(ROOT, "plugins", "codex", "skills", name, "SKILL.md"), "utf8");
  const frontmatter = (text) => text.split("---")[1];

  assert.match(frontmatter(skill("gswitch-invoke")), /disable-model-invocation:\s*true/);
  assert.doesNotMatch(frontmatter(skill("gswitch-review")), /disable-model-invocation/);
  const review = skill("gswitch-review");
  assert.match(review, /Never add `--write`/);
  assert.doesNotMatch(review.replace("Never add `--write`", ""), /--write/);
  for (const command of ["rescue.md", "review.md", "adversarial-review.md"]) {
    const source = fs.readFileSync(path.join(ROOT, "plugins", "codex", "commands", command), "utf8");
    assert.match(frontmatter(source), /disable-model-invocation:\s*true/, command);
  }
});
