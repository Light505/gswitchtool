// Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readClaudeSetup } from "../plugins/codex/scripts/lib/gswitch.mjs";

const plugin = fileURLToPath(new URL("../plugins/codex/", import.meta.url));
const lines = {
  "claude-only": "GSwitch setup: Claude only. Do not use Codex: no gswitch-delegate, gswitch-review or /codex commands unless the user asks.",
  "claude-codex": "GSwitch setup: Claude + Codex. Send bounded, self-contained coding tasks to Codex with the gswitch-delegate skill; keep decisions, design, debugging that needs this conversation, and edits shorter than their brief. After non-trivial changes run gswitch-review.",
  router: "GSwitch setup: Router. Follow the Router: line. If no Router: line appears, the router plugin is not installed: work as Claude only and tell the user once."
};
const setup = (name, mode = "mixed") => ({ version: 1, setup: name,
  router: { mode, claudeOnlyReview: "on", claudeAllowed: { haiku: ["low", "medium"], sonnet: ["low"], opus: [] } } });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-setup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".gswitchtool"); fs.mkdirSync(dir);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSWITCH_CONFIG_DIR: dir };
  const write = (value) => fs.writeFileSync(path.join(dir, "claude-setup.json"), typeof value === "string" ? value : JSON.stringify(value));
  function run(script, args = [], root = plugin, environment = env) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { env: environment, cwd: home, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    return result.stdout;
  }
  return { home, dir, env, write, run };
}

test("each setup produces its exact per-message hook context", (t) => {
  const f = fixture(t);
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8"));
  const hook = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.timeout, 5); assert.equal(hook.type, "command");
  assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-setup-hook.mjs"');
  for (const name of Object.keys(lines)) {
    f.write(setup(name));
    assert.deepEqual(JSON.parse(f.run("claude-setup-hook.mjs")), { hookSpecificOutput: {
      hookEventName: "UserPromptSubmit", additionalContext: lines[name]
    } });
    assert.equal(readClaudeSetup(f.env).setup, name);
  }
  f.write({ ...setup("router"), router: { ...setup("router").router, claudeAllowed: "invalid" } });
  assert.equal(JSON.parse(f.run("claude-setup-hook.mjs")).hookSpecificOutput.additionalContext, lines.router);
});

test("missing, unreadable, corrupt and invalid setup produces no output and exits zero", (t) => {
  const f = fixture(t);
  assert.equal(f.run("claude-setup-hook.mjs"), "");
  for (const value of ["{bad", "null", "[]", {}, { ...setup("router"), version: 2 }, setup("unknown"),
    { ...setup("router"), router: null }, setup("router", "off"),
    { ...setup("router"), router: { mode: "mixed", claudeOnlyReview: "bad" } }]) {
    f.write(value); assert.equal(f.run("claude-setup-hook.mjs"), ""); assert.equal(readClaudeSetup(f.env), null);
  }
  fs.rmSync(path.join(f.dir, "claude-setup.json")); fs.mkdirSync(path.join(f.dir, "claude-setup.json"));
  assert.equal(f.run("claude-setup-hook.mjs"), "");
});

test("invoke-status starts with the setup even when the app endpoint is unavailable", (t) => {
  const f = fixture(t);
  const status = () => f.run("codex-companion.mjs", ["invoke-status"]).split("\n")[0];
  assert.equal(status(), "Claude Code setup: unknown (open GSwitch once)");
  for (const [name, label] of [["claude-only", "Claude only"], ["claude-codex", "Claude + Codex"],
    ["router", "Router (mixed)"], ["router", "Router (claude)"], ["router", "Router (codex)"]]) {
    f.write(setup(name, label.match(/\((.+)\)/)?.[1] || "mixed"));
    assert.equal(status(), `Claude Code setup: ${label} (change it in GSwitch: Claude Code button)`);
  }
  f.write("{corrupt"); assert.equal(status(), "Claude Code setup: unknown (open GSwitch once)");
});

test("the Dev target reads only .gswitchtool-dev and environment overrides remain supported", (t) => {
  const f = fixture(t); f.write(setup("claude-only"));
  const copy = path.join(f.home, "plugin"); fs.cpSync(plugin, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, "gswitch-target.json"), JSON.stringify({ dataDir: ".gswitchtool-dev" }));
  const env = { ...f.env }; delete env.GSWITCH_CONFIG_DIR;
  assert.equal(f.run("claude-setup-hook.mjs", [], copy, env), "");
  const devDir = path.join(f.home, ".gswitchtool-dev"); fs.mkdirSync(devDir);
  fs.writeFileSync(path.join(devDir, "claude-setup.json"), JSON.stringify(setup("claude-codex")));
  assert.equal(JSON.parse(f.run("claude-setup-hook.mjs", [], copy, env)).hookSpecificOutput.additionalContext, lines["claude-codex"]);
  assert.match(f.run("codex-companion.mjs", ["invoke-status"], copy, env), /^Claude Code setup: Claude \+ Codex/);
  assert.equal(JSON.parse(f.run("claude-setup-hook.mjs", [], copy)).hookSpecificOutput.additionalContext, lines["claude-only"]);
});

test("delegate accepts Claude + Codex and router context while remaining model-invocable", () => {
  const text = fs.readFileSync(path.join(plugin, "skills/gswitch-delegate/SKILL.md"), "utf8");
  assert.doesNotMatch(text.split("---")[1], /disable-model-invocation/);
  assert.match(text.split("---")[1], /GSwitch setup: Claude \+ Codex/);
  const section = text.split("## 1.")[1].split("## 3.")[0];
  assert.match(section, /GSwitch setup: Claude \+ Codex/);
  assert.match(section, /mode=mixed or mode=codex/);
  assert.match(section, /Invoke Mode is off[\s\S]*do not delegate/);
});
