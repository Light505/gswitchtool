// Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const ARGS = ["invoke", "--model", "model-a", "--effort", "high"];
const change = (file, kind = { type: "add" }) => ({ path: file, kind, diff: "+fixture" });

// Like invoke-command.test.mjs: an in-process endpoint and the shared fake
// Codex fixture exercise the entire invoke command without provider actions.
async function fixture(body, behavior = "scope-approval") {
  const repo = makeTempDir("invoke-scope-repo-");
  const binDir = makeTempDir("invoke-scope-bin-");
  const configDir = makeTempDir("invoke-scope-config-");
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "build/\n");
  run("git", ["add", "."], { cwd: repo });
  const committed = run("git", ["commit", "-m", "init"], { cwd: repo });
  assert.equal(committed.status, 0, committed.stderr);
  const endpoint = process.platform === "win32"
    ? path.join("\\\\.\\pipe", `invoke-scope-${randomUUID()}`)
    : path.join(configDir, "invoke.sock");
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
        const result = request.method === "lease_open" ? { lease_id: "lease-1" }
          : request.method === "run_end" ? { outcome: "unchanged" } : {};
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  fs.writeFileSync(path.join(configDir, "invoke-endpoint.json"), JSON.stringify({ endpoint, token: "test-token", pid: process.pid }));
  const state = () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const invoke = (flags, changes = [], extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...ARGS, ...flags, "implement the task"], {
      cwd: repo,
      env: {
        ...buildEnv(binDir), GSWITCH_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_DATA: path.join(configDir, "plugin-data"),
        CODEX_COMPANION_DISABLE_BROKER: "1",
        GSWITCH_TEST_APPROVAL_CHANGES: JSON.stringify(changes), ...extraEnv
      },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  try { await body({ repo, state, invoke }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function successful(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }
function decision(state) { return state().approvalReplies.at(-1).result?.decision; }

test("in-scope absolute paths are accepted before editing", () => fixture(async ({ repo, state, invoke }) => {
  const result = await invoke(["--write", "--scope", "src/**", "--scope", "tests/**"], [change(path.join(repo, "src/task.js"))]);
  successful(result);
  assert.equal(state().lastThreadRequest.approvalPolicy, "untrusted");
  assert.equal(state().lastThreadRequest.approvalsReviewer, "user");
  assert.equal(decision(state), "accept");
  assert.equal(fs.readFileSync(path.join(repo, "src/task.js"), "utf8"), "approved fixture change\n");
  assert.match(state().lastTurnStart.prompt, /Edits outside these paths are declined: src\/\*\*, tests\/\*\*/);
  assert.match(result.stdout, /Scope: 0 change\(s\) declined/);
}));

test("out-of-scope edits are declined and reported once with the final reason", () => fixture(async ({ repo, state, invoke }) => {
  const result = await invoke(["--write", "--scope", "src/**"], [change("other.js"), change("other.js")], {
    GSWITCH_TEST_APPROVAL_ANSWER: "SCOPE REQUEST: other.js — needed by this task — add a helper"
  });
  successful(result);
  assert.equal(decision(state), "decline");
  assert.equal(fs.existsSync(path.join(repo, "other.js")), false);
  assert.match(result.stdout, /SCOPE REQUEST: other\.js — needed by this task — add a helper/);
  assert.equal(result.stdout.match(/SCOPE REQUEST: other\.js/g).length, 1);
  assert.match(result.stdout, /Scope: 1 change\(s\) declined/);
}));

test("mixed patches decline the whole patch and report each outside path", () => fixture(async ({ repo, state, invoke }) => {
  const result = await invoke(["--write", "--scope", "src/**", "--json"], [change("src/task.js"), change("other.js"), change("another.js")]);
  successful(result);
  assert.equal(decision(state), "decline");
  assert.equal(fs.existsSync(path.join(repo, "src/task.js")), false);
  assert.deepEqual(JSON.parse(result.stdout).scopeRequests, [
    { path: "other.js", reason: "fixture reason" }, { path: "another.js", reason: "fixture reason" }
  ]);
}));

test("git-ignored paths are accepted outside scope", () => fixture(async ({ repo, state, invoke }) => {
  const result = await invoke(["--write", "--scope", "src/**"], [change("build/output.js")]);
  successful(result);
  assert.equal(decision(state), "accept");
  assert.equal(fs.existsSync(path.join(repo, "build/output.js")), true);
  assert.match(result.stdout, /Scope: 0 change\(s\) declined/);
}));

test("command approvals are accepted in scoped write mode", () => fixture(async ({ state, invoke }) => {
  successful(await invoke(["--write", "--scope", "src/**"], [], { GSWITCH_TEST_APPROVAL_MODE: "command" }));
  assert.equal(decision(state), "accept");
}));

test("unknown server requests still receive -32601", () => fixture(async ({ state, invoke }) => {
  successful(await invoke(["--write", "--scope", "src/**"], [], { GSWITCH_TEST_APPROVAL_MODE: "unknown" }));
  assert.equal(state().approvalReplies.at(-1).error.code, -32601);
}));

for (const flags of [["--write"], ["--scope", "src/**"]]) {
  test(`without both write and scope (${flags.join(" ")}), policy remains never`, () => fixture(async ({ state, invoke }) => {
    const result = await invoke(flags, [change("src/task.js")]);
    successful(result);
    assert.equal(state().lastThreadRequest.approvalPolicy, "never");
    assert.equal(state().lastThreadRequest.approvalsReviewer, undefined);
    assert.equal(state().approvalReplies.at(-1).error.code, -32601);
    assert.doesNotMatch(state().lastTurnStart.prompt, /Edits outside these paths/);
    assert.doesNotMatch(result.stdout, /Scope:|SCOPE REQUEST:/);
  }));
}

test("resume of the same thread accepts a previously declined path with wider scope", () => fixture(async ({ repo, state, invoke }) => {
  const first = await invoke(["--write", "--scope", "src/**", "--json"], [change("other.js")]);
  successful(first);
  const thread = JSON.parse(first.stdout).threadId;
  const resumed = await invoke(["--write", "--scope", "other.js", "--resume-thread", thread, "--json"], [change("other.js")]);
  successful(resumed);
  assert.equal(state().lastThreadRequest.method, "thread/resume");
  assert.equal(state().lastThreadRequest.approvalPolicy, "untrusted");
  assert.equal(state().lastThreadRequest.approvalsReviewer, "user");
  assert.equal(JSON.parse(resumed.stdout).threadId, thread);
  assert.equal(decision(state), "accept");
  assert.equal(fs.existsSync(path.join(repo, "other.js")), true);
}));

test("worktree scope uses the worktree root and applies accepted changes", () => fixture(async ({ repo, state, invoke }) => {
  const result = await invoke(["--write", "--worktree", "--scope", "src/**", "--json"], [change("src/task.js")]);
  successful(result);
  assert.notEqual(state().lastTurnStart.cwd, repo);
  assert.equal(decision(state), "accept");
  assert.equal(JSON.parse(result.stdout).worktree.applied, true);
  assert.equal(fs.existsSync(path.join(repo, "src/task.js")), true);
}));

test("a kept worktree can resume its thread with wider scope", () => fixture(async ({ repo, state, invoke }) => {
  const first = await invoke(["--write", "--worktree", "--scope", "src/**", "--verify", 'node -e "process.exit(1)"', "--json"], [change("other.js")]);
  assert.equal(first.status, 4, first.stderr || first.stdout);
  const kept = JSON.parse(first.stdout);
  assert.ok(kept.worktree.keptAt);
  assert.equal(kept.scopeRequests.length, 1);
  const resumed = await invoke(["--write", "--scope", "other.js", "--resume-thread", kept.threadId, "--worktree-dir", kept.worktree.keptAt, "--json"], [change("other.js")]);
  successful(resumed);
  assert.equal(state().lastThreadRequest.approvalPolicy, "untrusted");
  assert.equal(decision(state), "accept");
  assert.equal(JSON.parse(resumed.stdout).worktree.applied, true);
  assert.equal(fs.existsSync(path.join(repo, "other.js")), true);
}));

test("rename destinations outside scope are declined", () => fixture(async ({ state, invoke }) => {
  const result = await invoke(["--write", "--scope", "src/**"], [change("src/task.js", { type: "update", move_path: "other.js" })]);
  successful(result);
  assert.equal(decision(state), "decline");
  assert.match(result.stdout, /SCOPE REQUEST: other\.js/);
}));

test("paths outside the repository are declined even with scope **", () => fixture(async ({ state, invoke }) => {
  const result = await invoke(["--write", "--scope", "**"], [change("../outside.js")]);
  successful(result);
  assert.equal(decision(state), "decline");
  assert.match(result.stdout, /SCOPE REQUEST: \.\.\/outside\.js/);
}));

test("shell edits outside scope keep the after-the-fact warning", () => fixture(async ({ invoke }) => {
  const result = await invoke(["--write", "--scope", "src/**"]);
  successful(result);
  assert.match(result.stdout, /WARNING: changed outside --scope: outside\.ts/);
}, "invoke-write"));
