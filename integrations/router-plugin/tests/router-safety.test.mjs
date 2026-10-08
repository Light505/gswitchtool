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
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-safety-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const setupDir = path.join(home, ".gswitchtool");
  fs.mkdirSync(setupDir);
  fs.writeFileSync(path.join(setupDir, "claude-setup.json"), JSON.stringify({ version: 1, setup: "router", router: { mode: "claude", claudeOnlyReview: "on" } }));
  const data = path.join(home, ".gswitchtool-router");
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  const hook = (event, extra = {}) => {
    const result = spawnSync(process.execPath, [script, "hook", event], { cwd: home, env, input: JSON.stringify({ session_id: "s1", cwd: project, ...extra }), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const session = (value) => {
    fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(data, "sessions", "s1.json"), JSON.stringify(value));
  };
  const edit = (extra = {}) => hook("PreToolUse", { tool_name: "Write", tool_input: { file_path: "src/a.js" }, ...extra });
  return { home, data, project, hook, session, edit };
}
const reason = (result) => result.hookSpecificOutput?.permissionDecisionReason;

test("a router error denies a subagent's edit and leaves the orchestrator's alone", (t) => {
  const f = fixture(t);
  // A file where the data folder belongs makes the state lock fail before any hook logic runs.
  fs.writeFileSync(f.data, "not a folder");
  const worker = f.edit({ agent_id: "a1" });
  assert.equal(worker.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reason(worker), /^Router error: .+\. Do not edit; stop and report this error\.$/);
  assert.deepEqual(f.edit(), {});
  assert.deepEqual(f.edit({ agent_id: "" }), {});
});

test("an edit from a bound worker whose worktree is gone is denied", (t) => {
  const f = fixture(t);
  const gone = path.join(f.home, "worktrees", "agent-gone");
  f.session({ bindings: { a1: { type: "router:haiku-low", scope: ["src/*"], cwd: gone } } });
  const result = f.edit({ agent_id: "a1" });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(reason(result), `WORKTREE GONE: ${gone} no longer exists, so this edit would land in the main checkout. Do not edit; stop and tell the orchestrator to start a new worker.`);
});

test("an edit from a router worker type without a binding is denied", (t) => {
  const f = fixture(t);
  f.session({});
  const result = f.edit({ agent_id: "x1", agent_type: "router:haiku-low" });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(reason(result), "Router has no scope for this worker; stop and report.");
  assert.deepEqual(f.edit({ agent_id: "x2", agent_type: "Explore" }), {});
  assert.deepEqual(f.edit(), {});
});
