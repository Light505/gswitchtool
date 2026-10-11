// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "gswitch-plugin-dev-"));
const devRoot = join(home, ".gswitchtool-dev-plugin", "plugins");
const codexDir = join(devRoot, "codex-dev");
const routerDir = join(devRoot, "router-dev");
const sessions = join(home, ".gswitchtool-dev", "dev-sessions");
const setupHook = join(codexDir, "scripts", "claude-setup-hook.mjs");
const devLine = "[Dev] Dev test session: follow the [Dev] lines and use the codex-dev / router-dev skills; ignore GSwitch setup and Router lines without [Dev].";

function env() {
  const copy = { ...process.env, USERPROFILE: home, HOME: home };
  delete copy.GSWITCH_CONFIG_DIR;
  delete copy.CLAUDE_PROJECT_DIR;
  return copy;
}

// Runs a hook through a plugin's dev-gate.mjs, passing hook JSON on stdin as Claude Code does.
function hook(gateDir, target, input, args = []) {
  const run = spawnSync(process.execPath, [join(gateDir, "dev-gate.mjs"), target, ...args], {
    cwd: gateDir,
    env: env(),
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function prompt(sessionId, text) {
  return { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: text };
}

test.after(() => rmSync(home, { recursive: true, force: true }));

test("plugin-dev builds both Dev plugins with the gate", () => {
  const run = spawnSync(process.execPath, [join(root, "scripts", "plugin-dev.mjs"), "--no-install"], {
    cwd: root,
    env: env(),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(run.status, 0, run.stderr);

  for (const dir of [codexDir, routerDir]) {
    assert.ok(existsSync(join(dir, "dev-gate.mjs")));
    const hooks = JSON.parse(readFileSync(join(dir, "hooks", "hooks.json"), "utf8"));
    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) {
        for (const entry of group.hooks) {
          assert.match(entry.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dev-gate\.mjs" "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//);
          assert.ok(entry.timeout > 0);
        }
      }
    }
  }
  assert.ok(existsSync(join(codexDir, "commands", "dev-on.md")));
  assert.ok(existsSync(join(routerDir, "skills", "dev-on", "SKILL.md")));
  assert.match(readFileSync(join(codexDir, "skills", "gswitch-invoke", "SKILL.md"), "utf8"),
    /description: "Only in a Dev test session \(a \[Dev\] line is present\)\. Use while/);
  assert.match(readFileSync(join(codexDir, "skills", "gswitch-invoke", "SKILL.md"), "utf8"), /codex-dev:codex-runner/);
  assert.match(readFileSync(join(routerDir, "skills", "route", "SKILL.md"), "utf8"),
    /description: Only in a Dev test session \(a \[Dev\] line is present\)\. Use for every/);
});

test("codex-dev gate is silent without a marker and marks lines after dev-on", () => {
  mkdirSync(join(home, ".gswitchtool-dev"), { recursive: true });
  writeFileSync(join(home, ".gswitchtool-dev", "claude-setup.json"), JSON.stringify({
    version: 1, setup: "router", router: { mode: "mixed", claudeOnlyReview: "off" }
  }));

  // a) no marker: the wrapped hook does not run and no marker is created
  assert.equal(hook(codexDir, setupHook, prompt("s1", "hello")), "");
  assert.equal(existsSync(sessions), false);

  // b) dev-on creates the marker and the wrapped output is marked
  const on = JSON.parse(hook(codexDir, setupHook, prompt("s1", "/codex-dev:dev-on")));
  assert.ok(existsSync(join(sessions, "s1")));
  assert.ok(on.hookSpecificOutput.additionalContext.startsWith("[Dev] GSwitch setup: Router"));

  // c) the same session stays on; another session stays silent
  const same = JSON.parse(hook(codexDir, setupHook, prompt("s1", "normal")));
  assert.ok(same.hookSpecificOutput.additionalContext.startsWith("[Dev] GSwitch setup: Router"));
  assert.equal(hook(codexDir, setupHook, prompt("s2", "normal")), "");
});

test("router-dev gate adds the Dev test session line once", () => {
  const out = JSON.parse(hook(routerDir, setupHook, prompt("s1", "normal")));
  const lines = out.hookSpecificOutput.additionalContext.split("\n").filter((line) => line === devLine);
  assert.equal(lines.length, 1);
  assert.equal(hook(routerDir, setupHook, prompt("s2", "normal")), "");
});

test("router-dev gate adopts a new session only when a handoff is pending", () => {
  const project = join(home, "handoff-project");
  const routerScript = join(routerDir, "scripts", "router.mjs");
  const start = (sessionId, source, cwd = project) => hook(routerDir, routerScript, { session_id: sessionId, hook_event_name: "SessionStart", source, cwd }, ["hook", "SessionStart"]);
  mkdirSync(join(home, ".gswitchtool-router-dev", "handoffs"), { recursive: true });
  writeFileSync(join(home, ".gswitchtool-router-dev", "handoffs", "h1.json"), JSON.stringify({
    version: 1, sessionId: "old", project, createdAt: "2026-02-02T10:00:00.000Z", size: 262000, limit: 250000, judgement: "Where it stands",
    facts: {}, nextRequests: [], usedAt: null, usedBy: null
  }));
  // No marker and no handoff for another folder: silent, and no marker is made.
  assert.equal(start("c0", "clear", join(home, "elsewhere")), "");
  assert.equal(existsSync(join(sessions, "c0")), false);
  assert.equal(start("c1", "resume"), "");
  const out = JSON.parse(start("c1", "clear"));
  assert.ok(existsSync(join(sessions, "c1")));
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /^\[Dev\] Handoff from the previous session \(ended at 262k of 250k, 2026-02-02T10:00:00\.000Z\)/m);
  assert.match(text, /^\[Dev\] Where it stands$/m);
  assert.ok(text.endsWith(`\n${devLine}`));
  // The handoff is used once: the next new session gets nothing and stays silent.
  assert.equal(start("c2", "startup"), "");
  assert.equal(existsSync(join(sessions, "c2")), false);
  assert.equal(JSON.parse(readFileSync(join(home, ".gswitchtool-router-dev", "handoffs", "h1.json"), "utf8")).usedBy, "c1");
  // codex-dev never adopts a session.
  assert.equal(hook(codexDir, setupHook, { session_id: "c3", hook_event_name: "SessionStart", source: "clear", cwd: project }), "");
  assert.equal(existsSync(join(sessions, "c3")), false);
});
