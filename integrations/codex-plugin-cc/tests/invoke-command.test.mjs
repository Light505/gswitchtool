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

// Answers like GSwitch's Invoke endpoint, from an in-memory policy.
async function startFakeGSwitch({ invokeMode = true } = {}) {
  const configDir = makeTempDir("gswitch-config-");
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\gswitch-test-${randomUUID()}` : path.join(configDir, "invoke.sock");
  const requests = [];
  const respond = (request) => {
    const fail = (code) => ({ id: request.id, error: { code } });
    if (request.token !== TOKEN) return fail("UNAUTHORIZED");
    if (request.method === "status") {
      return {
        id: request.id,
        result: {
          invoke_mode: invokeMode,
          allowed_invocation_profiles: invokeMode ? PROFILES : [],
          workers_running: 0,
          failover_in_progress: false
        }
      };
    }
    if (request.method === "validate") {
      if (!invokeMode) return fail("INVOKE_MODE_DISABLED");
      const profile = PROFILES.find((entry) => entry.model === request.params.model);
      if (!profile) return fail("MODEL_NOT_ALLOWED");
      if (!profile.reasoning_efforts.includes(request.params.reasoning_effort)) return fail("REASONING_NOT_ALLOWED");
      return { id: request.id, result: { allowed: true } };
    }
    return fail("UNKNOWN_METHOD");
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
  return { configDir, requests, close: () => new Promise((resolve) => server.close(resolve)) };
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
function companion(args, { repo, binDir, configDir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env: { ...buildEnv(binDir), GSWITCH_CONFIG_DIR: configDir },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

test("invoke-status reports the allowed profiles while Invoke Mode is on", async () => {
  const gswitch = await startFakeGSwitch();
  try {
    const ctx = { ...setupRepo(), configDir: gswitch.configDir };
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
  } finally {
    await gswitch.close();
  }
});

test("invoke-status tells Claude not to delegate in Manual Mode", async () => {
  const gswitch = await startFakeGSwitch({ invokeMode: false });
  try {
    const ctx = { ...setupRepo(), configDir: gswitch.configDir };
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Invoke Mode is off in GSwitch/);
  } finally {
    await gswitch.close();
  }
});

test("invoke-status reports GSwitch as unavailable when it is not running", async () => {
  const ctx = { ...setupRepo(), configDir: makeTempDir("gswitch-config-") };
  const result = await companion(["invoke-status", "--json"], ctx);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.available, false);
  assert.equal(report.code, "GSWITCH_UNAVAILABLE");
});

test("invoke refuses a disallowed model, effort, or Manual Mode before starting Codex", async () => {
  for (const [invokeMode, model, effort, code] of [
    [true, "model-z", "high", "MODEL_NOT_ALLOWED"],
    [true, "model-b", "high", "REASONING_NOT_ALLOWED"],
    [false, "model-a", "high", "INVOKE_MODE_DISABLED"]
  ]) {
    const gswitch = await startFakeGSwitch({ invokeMode });
    try {
      const ctx = { ...setupRepo(), configDir: gswitch.configDir };
      const result = await companion(["invoke", "--json", "--model", model, "--effort", effort, "do the work"], ctx);
      assert.equal(result.status, 2, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "rejected");
      assert.equal(payload.code, code);
      assert.equal(fs.existsSync(ctx.statePath), false, "Codex must not start for a rejected request");
    } finally {
      await gswitch.close();
    }
  }
});

test("invoke requires Claude to choose both a model and an effort", async () => {
  const gswitch = await startFakeGSwitch();
  try {
    const ctx = { ...setupRepo(), configDir: gswitch.configDir };
    const result = await companion(["invoke", "--model", "model-a", "do the work"], ctx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invoke requires --model and --effort/);
    assert.equal(gswitch.requests.length, 0);
  } finally {
    await gswitch.close();
  }
});

test("invoke runs an allowed request on its own app server with the chosen settings", async () => {
  const gswitch = await startFakeGSwitch();
  try {
    const ctx = { ...setupRepo(), configDir: gswitch.configDir };
    const result = await companion(
      ["invoke", "--json", "--model", "model-a", "--effort", "xhigh", "--write", "implement the feature"],
      ctx
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "progress stays out of the invoking model's output");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.code, null);
    assert.ok(payload.threadId);
    assert.match(payload.jobId, /^task-/);
    assert.deepEqual(gswitch.requests.map((request) => request.method), ["validate"]);
    assert.deepEqual(gswitch.requests[0].params, { model: "model-a", reasoning_effort: "xhigh" });

    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.lastTurnStart.model, "model-a");
    assert.equal(fakeState.lastTurnStart.effort, "xhigh");
    assert.equal(fakeState.lastTurnStart.prompt, "implement the feature");
    assert.equal(fakeState.lastThreadRequest.sandbox, "workspace-write");
    assert.equal(loadBrokerSession(ctx.repo), null, "invoke workers do not use the shared broker");
  } finally {
    await gswitch.close();
  }
});

test("invoke output is Codex's answer plus one resume line", async () => {
  const gswitch = await startFakeGSwitch();
  try {
    const ctx = { ...setupRepo(), configDir: gswitch.configDir };
    const result = await companion(["invoke", "--model", "model-b", "--effort", "medium", "review the change"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    assert.match(lines.at(-1), /^\[codex invoke\] completed · thread \S+ · job task-\S+ · model-b\/medium$/);
    assert.equal(readFakeState(ctx.statePath).lastThreadRequest.sandbox, "read-only");
  } finally {
    await gswitch.close();
  }
});

test("invoke --resume-thread continues the named thread", async () => {
  const gswitch = await startFakeGSwitch();
  try {
    const ctx = { ...setupRepo(), configDir: gswitch.configDir };
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
  } finally {
    await gswitch.close();
  }
});

test("invoke reports a usage limit with the thread needed to resume it", async () => {
  const gswitch = await startFakeGSwitch();
  try {
    const ctx = { ...setupRepo("usage-limit"), configDir: gswitch.configDir };
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(payload.code, "USAGE_LIMIT_EXCEEDED");
    assert.ok(payload.threadId);
  } finally {
    await gswitch.close();
  }
});
