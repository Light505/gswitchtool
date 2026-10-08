// Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
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
const REPLY_FORMAT = "\nReply format (end with at most 15 lines):\nChanged: one line per file, what changed\nTests: commands run + pass/fail\nOpen questions: none, or list them";

// Answers like GSwitch's Invoke endpoint from an in-memory policy. A failover
// "succeeds" unless failoverError is set; the fake does not switch accounts.
async function startFakeGSwitch({
  invokeMode = true,
  failoverError = null,
  manualAfterLease = false,
  waitingForCodex = false,
  failoverDetail = null,
  paused = null,
  maxTasks = null,
  taskDefaults = null,
  exclusiveModel = null,
  signedOut = false,
  stopTask = false,
  killAppServerAfterMs = null
} = {}) {
  const configDir = makeTempDir("gswitch-config-");
  const endpoint =
    process.platform === "win32"
      ? path.join("\\\\.\\pipe", `gswitch-test-${randomUUID()}`)
      : path.join(configDir, "invoke.sock");
  const requests = [];
  const codexHome = path.join(configDir, "codex-home");
  const policy = { invokeMode };
  const respond = (request) => {
    const fail = (code) => ({ id: request.id, error: { code } });
    const ok = (result = {}) => ({ id: request.id, result });
    if (request.token !== TOKEN) return fail("UNAUTHORIZED");
    switch (request.method) {
      case "status":
        return ok({
          invoke_mode: policy.invokeMode,
          allowed_invocation_profiles: policy.invokeMode
            ? PROFILES.map((profile) => (profile.model === exclusiveModel ? { ...profile, exclusive: true } : profile))
            : [],
          workers_running: 0,
          codex_home: codexHome,
          codex_signed_out: signedOut,
          failover_in_progress: waitingForCodex,
          ...(waitingForCodex ? { waiting_for_codex_to_close: true } : {}),
          ...(paused ? { paused } : {}),
          ...(maxTasks ? { max_concurrent_tasks: maxTasks } : {}),
          ...(taskDefaults ? { task_defaults: taskDefaults } : {})
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
        return ok({ lease_id: "lease-1", codex_home: codexHome });
      }
      case "run_app_server":
        if (killAppServerAfterMs !== null) {
          // Like GSwitch's Stop: the App Server tree dies while its turn runs.
          const pid = request.params.pid;
          setTimeout(() => {
            if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
            else try { process.kill(pid, "SIGKILL"); } catch {}
          }, killAppServerAfterMs);
        }
        return ok();
      case "run_begin":
      case "run_thread":
        return ok();
      case "run_end":
        return ok({ outcome: stopTask ? "stopped" : "unchanged" });
      case "task_result":
        return ok();
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
    codexHome,
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
      env: { ...buildEnv(binDir), GSWITCH_CONFIG_DIR: configDir, CLAUDE_PLUGIN_DATA: path.join(configDir, "plugin-data"), ...env },
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

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function addProtectedText(repo) {
  const file = path.join(repo, "protected.txt");
  fs.writeFileSync(file, "before\n<!-- gswitch-protected:start -->\nkeep this exact rule\n<!-- gswitch-protected:end -->\nafter\n");
  run("git", ["add", "protected.txt"], { cwd: repo });
  run("git", ["commit", "-m", "add protected text fixture"], { cwd: repo });
  return file;
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
      codex_signed_out: false,
      failover_in_progress: false
    });
    assert.equal(gswitch.requests[0].token, TOKEN);

    const text = await companion(["invoke-status"], ctx);
    assert.match(text.stdout, /- model-a: high, xhigh/);
    assert.match(text.stdout, /- model-b: medium/);
    assert.doesNotMatch(text.stdout, /signed out/);
  }));

test("invoke-status says first that Codex is signed out in GSwitch", () =>
  withGSwitch({ signedOut: true }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^Codex is signed out in GSwitch: runs will be refused \(CODEX_SIGNED_OUT\) until the user presses Switch on an account allowed in Invoke Mode\.\n/
    );
    assert.match(result.stdout, /- model-a: high, xhigh/);
  }));

test("invoke-status marks a model only some accounts offer", () =>
  withGSwitch({ exclusiveModel: "model-b" }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /- model-a: high, xhigh\n/);
    assert.match(result.stdout, /- model-b: medium \(only on some of the user's accounts: GSwitch switches to one when this model is used/);
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

    assert.deepEqual(gswitch.methods(), ["lease_open", "run_begin", "run_app_server", "run_thread", "run_end", "task_result"]);
    const [lease, , appServer, thread] = gswitch.requests;
    assert.equal(lease.params.model, "model-a");
    assert.equal(lease.params.reasoning_effort, "xhigh");
    assert.equal(lease.params.write, true);
    assert.ok(Number.isInteger(appServer.params.pid) && appServer.params.pid > 0);
    assert.equal(thread.params.thread_id, payload.threadId);

    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.appServerCodexHome, gswitch.codexHome);
    assert.equal(fakeState.lastTurnStart.model, "model-a");
    assert.equal(fakeState.lastTurnStart.effort, "xhigh");
    assert.equal(fakeState.lastTurnStart.prompt, `implement the feature${REPLY_FORMAT}`);
    assert.equal(fakeState.lastThreadRequest.sandbox, "workspace-write");
    assert.equal(loadBrokerSession(ctx.repo), null, "invoke workers do not use the shared broker");
  }));

test("a read-only invoke shows a short answer whole and adds no reply format", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", "--model", "model-b", "--effort", "medium", "review the change"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
    assert.doesNotMatch(result.stdout, /Full answer:/, "a short answer is not cut");
    assert.match(result.stdout, /\[codex invoke\] completed · thread \S+ · job task-\S+ · model-b\/medium/);
    assert.doesNotMatch(readFakeState(ctx.statePath).lastTurnStart.prompt, /Reply format/);
    assert.equal(readFakeState(ctx.statePath).lastThreadRequest.sandbox, "read-only");
  }));

test("invoke-status lists the user's default model per kind of task", () =>
  withGSwitch({ taskDefaults: { review: { model: "model-b", effort: "medium" } } }, undefined, async (ctx) => {
    const result = await companion(["invoke-status"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /The user's default per kind of task:\r?\n- review: model-b medium/);
  }));

test("a refused invoke shows GSwitch's message and code in text output", () =>
  withGSwitch({ paused: { resumes_at: null } }, undefined, async (ctx) => {
    const result = await companion(["invoke", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /PAUSE ALL WORK/);
    assert.match(result.stdout, /\[codex invoke\] rejected \(INVOKE_PAUSED\)/);
  }));

test("invoke reports git diff facts and files outside repeatable scope globs", () =>
  withGSwitch({}, "invoke-write", async (ctx) => {
    addProtectedText(ctx.repo);
    const result = await companion([
      "invoke", "--json", "--model", "model-a", "--effort", "high", "--write",
      "--scope", "src/**", "--scope", "tests/**,docs/**", "change a file"
    ], ctx);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.diff.files, [{ path: "outside.ts", added: 2, deleted: 0 }]);
    assert.deepEqual([payload.diff.totalFiles, payload.diff.added, payload.diff.deleted], [1, 2, 0]);
    assert.equal(payload.output, "Changed: outside.ts — added fixture changes\nTests: fixture — passed\nOpen questions: none");
    assert.ok(payload.warnings.includes("WARNING: changed outside --scope: outside.ts"));
    assert.equal(payload.protected, undefined);
    assert.doesNotMatch(payload.warnings.join("\n"), /protected text changed/);
  }));

test("invoke warns and fails when Codex changes protected text", () =>
  withGSwitch({}, "invoke-protected-change", async (ctx) => {
    const protectedFile = addProtectedText(ctx.repo);
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "change a rule"], ctx);
    assert.equal(result.status, 5, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.protected, { changed: ["protected.txt"] });
    assert.ok(payload.warnings.includes("WARNING: protected text changed: protected.txt"));
    assert.match(fs.readFileSync(protectedFile, "utf8"), /rewrite this rule/);
  }));

test("invoke warns and fails when Codex deletes a protected block", () =>
  withGSwitch({}, "invoke-protected-delete", async (ctx) => {
    const protectedFile = addProtectedText(ctx.repo);
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "remove a rule"], ctx);
    assert.equal(result.status, 5, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.protected, { changed: ["protected.txt"] });
    assert.ok(payload.warnings.includes("WARNING: protected text changed: protected.txt"));
    assert.doesNotMatch(fs.readFileSync(protectedFile, "utf8"), /gswitch-protected:start/);
  }));

test("invoke --worktree keeps protected text changes out of the user's tree", () =>
  withGSwitch({}, "invoke-worktree-protected-change", async (ctx) => {
    const protectedFile = addProtectedText(ctx.repo);
    const original = fs.readFileSync(protectedFile, "utf8");
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "change a rule"], ctx);
    assert.equal(result.status, 4, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.protected, { changed: ["protected.txt"] });
    assert.equal(payload.worktree.applied, false);
    assert.equal(payload.worktree.reason, "protected text changed");
    assert.ok(payload.worktree.keptAt);
    assert.equal(fs.readFileSync(protectedFile, "utf8"), original);
    assert.match(fs.readFileSync(path.join(payload.worktree.keptAt, "protected.txt"), "utf8"), /rewrite this rule/);
  }));

test("git facts leave out edits that were already in the working tree before the run", () =>
  withGSwitch({}, "invoke-write", async (ctx) => {
    fs.appendFileSync(path.join(ctx.repo, "README.md"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(ctx.repo, "outside.ts"), "zero\none\n");
    fs.writeFileSync(path.join(ctx.repo, "notes.txt"), "user notes\n");
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "change a file"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.diff.files, [{ path: "outside.ts", added: 1, deleted: 1 }]);
  }));

test("invoke --worktree applies a clean task patch and removes its worktree", () =>
  withGSwitch({}, "invoke-worktree-apply", async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.worktree, { applied: true, conflictsResolved: false, keptAt: null, reason: null });
    assert.equal(readText(path.join(ctx.repo, "task.txt")), "codex task change\n");
    assert.match(payload.diff.files.map((file) => file.path).join(","), /task\.txt/);
    assert.equal(fs.existsSync(payload.worktree.keptAt ?? ""), false);
  }));

test("invoke --worktree waits for another git process's index lock", () =>
  withGSwitch({}, "invoke-worktree-apply", async (ctx) => {
    const lock = path.join(ctx.repo, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    setTimeout(() => fs.rmSync(lock, { force: true }), 1500);
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).worktree.applied, true);
  }));

test("a refused worktree invoke leaves no worktree behind", () =>
  withGSwitch({ paused: { resumes_at: null } }, "invoke-worktree-apply", async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "INVOKE_PAUSED");
    assert.equal(payload.worktree, undefined);
    const dir = path.join(ctx.repo, ".git", "gswitch-worktrees");
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
    const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: ctx.repo, encoding: "utf8" }).stdout;
    assert.equal(listed.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length, 1);
  }));

test("invoke --worktree starts from the tracked uncommitted working tree", () =>
  withGSwitch({}, "invoke-worktree-apply", async (ctx) => {
    fs.writeFileSync(path.join(ctx.repo, "README.md"), "user uncommitted work\n");
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFakeState(ctx.statePath).lastTurnStart.readme.replace(/\r\n/g, "\n"), "user uncommitted work\n");
    assert.equal(readText(path.join(ctx.repo, "README.md")), "user uncommitted work\n");
    assert.equal(readText(path.join(ctx.repo, "task.txt")), "codex task change\n");
  }));

test("invoke --worktree resolves one merge conflict by resuming its thread", () =>
  withGSwitch({}, "invoke-worktree-conflict", async (ctx, gswitch) => {
    const mainFile = path.join(ctx.repo, "README.md");
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], {
      ...ctx, env: { GSWITCH_TEST_USER_CHANGE_FILE: mainFile }
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.worktree, { applied: true, conflictsResolved: true, keptAt: null, reason: null });
    assert.equal(gswitch.methods().filter((method) => method === "run_begin").length, 2);
    const turns = readFakeState(ctx.statePath).turns;
    assert.equal(turns[0].threadId, turns[1].threadId);
    assert.match(turns[1].prompt, /The user's tree changed while you worked/);
    assert.match(fs.readFileSync(mainFile, "utf8"), /codex task change/);
    assert.match(fs.readFileSync(mainFile, "utf8"), /user tree change/);
  }));

test("unresolved worktree conflict is kept and leaves the user's tree untouched", () =>
  withGSwitch({}, "invoke-worktree-unresolved-conflict", async (ctx) => {
    const mainFile = path.join(ctx.repo, "README.md");
    const original = fs.readFileSync(mainFile, "utf8");
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], {
      ...ctx, env: { GSWITCH_TEST_USER_CHANGE_FILE: mainFile }
    });
    assert.equal(result.status, 4, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.worktree.applied, false);
    assert.ok(payload.worktree.keptAt);
    assert.match(payload.worktree.reason, /Unresolved merge conflicts/);
    assert.match(payload.warnings.join("\n"), /WARNING: worktree changes were not applied/);
    assert.equal(fs.readFileSync(mainFile, "utf8"), "user tree change\n");
    assert.notEqual(fs.readFileSync(mainFile, "utf8"), original);
    assert.equal(fs.existsSync(payload.worktree.keptAt), true);
  }));

test("a worktree with verification still failing is kept without applying changes", () =>
  withGSwitch({}, "invoke-worktree-apply", async (ctx) => {
    const result = await companion([
      "invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree",
      "--verify", "node -e \"process.exit(1)\"", "do the work"
    ], ctx);
    assert.equal(result.status, 4, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.verify.passed, false);
    assert.equal(readText(path.join(ctx.repo, "README.md")), "hello\n");
    assert.equal(fs.existsSync(path.join(ctx.repo, "task.txt")), false);
    assert.match(payload.worktree.reason, /verification failed/);
    assert.match(payload.warnings.join("\n"), /WARNING: worktree kept: verification failed/);
    assert.equal(fs.existsSync(payload.worktree.keptAt), true);
  }));

test("worktree links ignored node_modules and cleanup preserves the real dependency tree", () =>
  withGSwitch({}, "invoke-worktree-apply", async (ctx) => {
    const dependencies = path.join(ctx.repo, "node_modules");
    fs.mkdirSync(dependencies);
    fs.writeFileSync(path.join(dependencies, "keep.txt"), "real dependencies");
    fs.writeFileSync(path.join(ctx.repo, ".gitignore"), "node_modules/\n");
    run("git", ["add", ".gitignore"], { cwd: ctx.repo });
    run("git", ["commit", "-m", "ignore dependencies"], { cwd: ctx.repo });
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFakeState(ctx.statePath).lastTurnStart.nodeModulesLinked, true);
    assert.equal(fs.readFileSync(path.join(dependencies, "keep.txt"), "utf8"), "real dependencies");
    assert.equal(fs.existsSync(path.join(dependencies, "keep.txt")), true);
    const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd: ctx.repo }).stdout;
    assert.doesNotMatch(worktrees, /gswitch-worktrees/);
  }));

test("invoke --worktree requires --write and rejects before contacting GSwitch", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "rejected");
    assert.equal(payload.code, "WORKTREE_UNAVAILABLE");
    assert.match(payload.message, /requires --write/);
    assert.equal(gswitch.requests.length, 0);
  }));

test("invoke --worktree requires a git repository before contacting GSwitch", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    ctx.repo = makeTempDir("invoke-no-git-");
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "rejected");
    assert.equal(payload.code, "WORKTREE_UNAVAILABLE");
    assert.match(payload.message, /requires a git repository/);
    assert.equal(gswitch.requests.length, 0);
  }));

test("a stopped worktree invoke keeps its directory for resuming", () =>
  withGSwitch({ stopTask: true }, "invoke-worktree-apply", async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--write", "--worktree", "do the work"], ctx);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.worktree.applied, false);
    assert.equal(payload.worktree.reason, "interrupted or stopped");
    assert.equal(fs.existsSync(payload.worktree.keptAt), true);
    assert.equal(payload.worktree.keptAt.startsWith(path.join(ctx.repo, ".git", "gswitch-worktrees")), true);
  }));

test("invoke verifies a command after Codex completes", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", "--model", "model-a", "--effort", "high", "--verify", "node --version", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verify: passed \(node --version, \d+s\)/);
  }));

test("failed verification retries the same Codex thread once and can pass", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const counter = path.join(path.dirname(ctx.statePath), "verify-count");
    const verifyFile = path.join(ctx.repo, "verify.mjs");
    fs.writeFileSync(verifyFile, `import fs from "node:fs";\nconst file = ${JSON.stringify(counter)};\nconst count = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0) + 1;\nfs.writeFileSync(file, String(count));\nconsole.log(count === 1 ? "first failure" : "passed");\nprocess.exit(count === 1 ? 1 : 0);\n`);
    const result = await companion(["invoke", "--model", "model-a", "--effort", "high", "--verify", "node verify.mjs", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verify: passed after 1 retry/);
    assert.match(result.stderr, /^$/);
    const turns = readFakeState(ctx.statePath).turns;
    assert.equal(turns.length, 2);
    assert.equal(turns[1].threadId, turns[0].threadId);
    assert.match(turns[1].prompt, /The verification command failed\. Fix the cause, do not weaken tests or checks\./);
    assert.match(turns[1].prompt, /first failure/);
    assert.equal(gswitch.methods().filter((method) => method === "run_begin").length, 2);
  }));

test("verification still failing after one retry returns exit code 3", () =>
  withGSwitch({}, undefined, async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "--verify", "node -e \"console.log('still failing'); process.exit(1)\"", "do the work"], ctx);
    assert.equal(result.status, 3, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.verify.passed, false);
    assert.equal(payload.verify.retries, 1);
    assert.match(payload.verify.output, /still failing/);
    assert.equal(readFakeState(ctx.statePath).turns.length, 2);
  }));

test("read-only invoke warns when git shows file changes", () =>
  withGSwitch({}, "invoke-write", async (ctx) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.warnings.includes("WARNING: read-only run changed files"));
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

test("a resumed thread is reported to GSwitch, so its task view shows it running", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const first = JSON.parse(
      (await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "first task"], ctx)).stdout
    );
    gswitch.requests.length = 0;
    const resumed = await companion(
      ["invoke", "--json", "--model", "model-a", "--effort", "high", "--resume-thread", first.threadId, "keep going"],
      ctx
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const reported = gswitch.requests.filter((request) => request.method === "run_thread");
    assert.deepEqual(reported.map((request) => request.params.thread_id), [first.threadId]);
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
      "run_end",
      "task_result"
    ]);
    const fakeState = readFakeState(ctx.statePath);
    assert.equal(fakeState.threads.length, 1, "the failover must not create a new Codex thread");
    assert.equal(fakeState.turns.length, 2);
    const [first, second] = fakeState.turns;
    assert.equal(first.prompt, `implement the feature${REPLY_FORMAT}`);
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

test("a task the user stops in GSwitch is reported as stopped, not retried", () =>
  withGSwitch({ stopTask: true }, "usage-limit-once", async (ctx, gswitch) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "STOPPED_BY_USER");
    assert.match(payload.message, /Do not restart or retry it/);
    assert.ok(payload.threadId);
    assert.equal(readFakeState(ctx.statePath).turns.length, 1, "nothing resumes after a stop");
    assert.ok(!gswitch.methods().includes("limit_reached"));
    const reported = gswitch.requests.find((request) => request.method === "task_result");
    assert.deepEqual(reported.params, { lease_id: "lease-1", status: "failed", code: "STOPPED_BY_USER" });
  }));

for (const [when, killAfterMs] of [["while Codex starts", 20], ["while its turn runs", 800]]) {
  // The killed App Server can never finish its turn: without the fix this hangs
  // or crashes, so the timeout and the parsed result are the proof.
  test(`a task stopped ${when} ends with a result instead of waiting or crashing`, { timeout: 60_000 }, () =>
    withGSwitch({ stopTask: true, killAppServerAfterMs: killAfterMs }, "interruptible-slow-task", async (ctx, gswitch) => {
      const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).code, "STOPPED_BY_USER");
      assert.ok(gswitch.methods().includes("task_result"));
    }));
}

test("a finished task reports its result to GSwitch", () =>
  withGSwitch({}, undefined, async (ctx, gswitch) => {
    const result = await companion(["invoke", "--json", "--model", "model-a", "--effort", "high", "do the work"], ctx);
    assert.equal(result.status, 0, result.stderr);
    const reported = gswitch.requests.find((request) => request.method === "task_result");
    assert.deepEqual(reported.params, { lease_id: "lease-1", status: "completed", code: null });
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
    assert.deepEqual(fakeState.turns.map((turn) => turn.prompt), [`do the work${REPLY_FORMAT}`, FAILOVER_RESUME_PROMPT]);
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
  for (const command of ["review.md"]) {
    const source = fs.readFileSync(path.join(ROOT, "plugins", "codex", "commands", command), "utf8");
    assert.match(frontmatter(source), /disable-model-invocation:\s*true/, command);
  }
});
