// Added by Light505 for gswitchtool (2026): tests for Invoke Mode support. See CREDITS.md in gswitchtool.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveJobsDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

// These tests own their app-server processes so none outlive the test run.
function directEnv(binDir) {
  return { ...buildEnv(binDir), CODEX_COMPANION_DISABLE_BROKER: "1" };
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

function companion(args, { repo, binDir }) {
  return run(process.execPath, [SCRIPT, ...args], { cwd: repo, env: directEnv(binDir) });
}

function readFakeState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

test("task --resume-thread resumes the named thread rather than the latest one", () => {
  const ctx = setupRepo();
  const first = companion(["task", "--json", "first task"], ctx);
  assert.equal(first.status, 0, first.stderr);
  const second = companion(["task", "--json", "second task"], ctx);
  assert.equal(second.status, 0, second.stderr);
  const firstThread = JSON.parse(first.stdout).threadId;
  const secondThread = JSON.parse(second.stdout).threadId;
  assert.notEqual(firstThread, secondThread);

  const resumed = companion(
    ["task", "--json", "--resume-thread", firstThread, "--model", "gpt-test", "--effort", "high", "--write", "continue the first task"],
    ctx
  );

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).threadId, firstThread);
  const fakeState = readFakeState(ctx.statePath);
  assert.equal(fakeState.lastTurnStart.threadId, firstThread);
  assert.equal(fakeState.lastTurnStart.model, "gpt-test");
  assert.equal(fakeState.lastTurnStart.effort, "high");
  assert.equal(fakeState.lastTurnStart.prompt, "continue the first task");
  assert.equal(fakeState.threads.length, 2, "resuming must not create a new thread");
});

test("task --resume-thread cannot be combined with other resume routing", () => {
  const ctx = setupRepo();
  for (const flag of ["--resume-last", "--resume", "--fresh"]) {
    const result = companion(["task", "--resume-thread", "thr_1", flag, "go"], ctx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Choose either --resume-thread/);
  }
});

test("task --resume-thread rejects an empty thread ID", () => {
  const ctx = setupRepo();
  const result = companion(["task", "--resume-thread", " ", "go"], ctx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--resume-thread requires a Codex thread ID/);
});

test("task JSON and job record keep the structured usage-limit error", () => {
  const ctx = setupRepo("usage-limit");
  const result = companion(["task", "--json", "do the work"], ctx);

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.codexErrorInfo, "usageLimitExceeded");
  assert.ok(payload.threadId, "the thread ID must survive a usage-limit failure");

  const jobsDir = resolveJobsDir(ctx.repo);
  const jobFiles = fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json"));
  assert.equal(jobFiles.length, 1);
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFiles[0]), "utf8"));
  assert.equal(job.status, "failed");
  assert.equal(job.threadId, payload.threadId);
  assert.equal(job.result.error.codexErrorInfo, "usageLimitExceeded");
});

test("a successful task reports no error", () => {
  const ctx = setupRepo();
  const result = companion(["task", "--json", "do the work"], ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).error, null);
});

test("task forwards model-specific efforts beyond the legacy list", () => {
  const ctx = setupRepo();
  for (const effort of ["max", "ultra"]) {
    const result = companion(["task", "--effort", effort, "think hard"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFakeState(ctx.statePath).lastTurnStart.effort, effort);
  }
});

test("task rejects a value that cannot be an effort name before starting Codex", () => {
  const ctx = setupRepo();
  const result = companion(["task", "--effort", "high; rm", "go"], ctx);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported reasoning effort/);
  assert.equal(fs.existsSync(ctx.statePath), false, "Codex must not be started");
});

test("CODEX_COMPANION_DISABLE_BROKER runs the task without a shared broker", () => {
  const ctx = setupRepo();
  const result = companion(["task", "do the work"], ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadBrokerSession(ctx.repo), null);
});
