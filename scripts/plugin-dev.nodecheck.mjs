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
  return copy;
}

// Runs a hook through a plugin's dev-gate.mjs, passing hook JSON on stdin as Claude Code does.
function hook(gateDir, target, input) {
  const run = spawnSync(process.execPath, [join(gateDir, "dev-gate.mjs"), target], {
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
  assert.match(readFileSync(join(codexDir, "skills", "gswitch-delegate", "SKILL.md"), "utf8"),
    /description: "Only in a Dev test session \(a \[Dev\] line is present\)\. Use when/);
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
