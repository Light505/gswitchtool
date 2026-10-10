// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectKey, matchesScope, normalizeCodexSpeed } from "../scripts/router.mjs";
import { models, efforts, workerNames, defaultAllowed, costPerTask } from "../scripts/workers.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(plugin, "../..");
const script = path.join(plugin, "scripts", "router.mjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSWITCH_ROUTER_SAMPLE_ROLL: "1" };
  const data = path.join(home, ".gswitchtool-router");
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  const run = (args, input = "", entry = script) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: home, env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  function write(relative, value) {
    const file = path.join(data, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  const read = (relative) => JSON.parse(fs.readFileSync(path.join(data, relative), "utf8"));
  const hook = (event, extra = {}) => JSON.parse(run(["hook", event], { session_id: "s1", cwd: project, ...extra }));
  const setupFile = path.join(home, ".gswitchtool", "claude-setup.json");
  function setup(value) {
    fs.mkdirSync(path.dirname(setupFile), { recursive: true });
    fs.writeFileSync(setupFile, typeof value === "string" ? value : JSON.stringify(value));
  }
  function settings(value) {
    const previous = fs.existsSync(setupFile) ? JSON.parse(fs.readFileSync(setupFile, "utf8")).router : {};
    setup({ version: 1, setup: "router", router: { mode: "claude", claudeOnlyReview: "on", ...previous, ...value } });
  }
  const mode = (value) => {
    if (value === "off") setup({ version: 1, setup: "claude-only", router: { mode: "mixed", claudeOnlyReview: "on" } });
    else settings({ mode: value });
    return run(["mode", "s1", project]);
  };
  const allowed = () => run(["mode", "s1", project]).split("\n")[1] + "\n";
  const planned = new Set();
  const plan = (entry = script) => {
    if (planned.has(entry)) return;
    const out = run(["plan", "s1", project, "--task", "t1", "--kind", "implement", "--difficulty", "small"], "", entry);
    if (out !== "Router is off.\n") planned.add(entry);
    return out;
  };
  const agent = (extra = {}, top = {}) => {
    plan();
    return hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", ...extra, prompt: `${extra.prompt ?? "Do work\nSCOPE: src/*"}\nTASK: t1` }, ...top });
  };
  const decision = (result) => result.hookSpecificOutput?.permissionDecision;
  function git(args, cwd = project) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function init() {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Router Test"]);
    git(["config", "user.email", "router@example.invalid"]);
    git(["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(project, ".gitignore"), "ignored/\nnode_modules/\ntarget/\n");
    fs.writeFileSync(path.join(project, "file.txt"), "base\n");
    git(["add", "."]); git(["commit", "-m", "base"]);
  }
  return { home, env, data, project, run, write, read, hook, mode, setupFile, setup, settings, allowed, agent, decision, git, init, plan };
}

test("missing, corrupt or invalid app setup is off; other setups ignore old router choices", (t) => {
  const f = fixture(t);
  f.write("config.json", { default: "codex", claudeOnlyReview: "off", claudeAllowed: {}, projects: { [f.project]: { mode: "mixed" } } });
  f.write("sessions/s1.json", { mode: "claude", claudeOnlyReview: "off" });
  const off = () => {
    assert.match(f.run(["mode", "s1", f.project]), /^Router: Off \(GSwitch setup\)/);
    assert.deepEqual(f.hook("UserPromptSubmit"), {});
  };
  off();
  for (const value of ["{broken", "null", "[]", {}, { version: 2, setup: "router" },
    { version: 1, setup: "router", router: { mode: "off", claudeOnlyReview: "on" } },
    { version: 1, setup: "router", router: { mode: "mixed", claudeOnlyReview: "invalid" } }]) {
    f.setup(value); off();
  }
  for (const setup of ["claude-only", "claude-codex"]) {
    f.setup({ version: 1, setup, router: { mode: "mixed", claudeOnlyReview: "on" } }); off();
  }
  fs.rmSync(f.setupFile);
  fs.mkdirSync(f.setupFile); off();
});

test("the app alone supplies mode, review and allowed workers, read on each message", (t) => {
  const f = fixture(t);
  f.write("config.json", { default: "codex", claudeOnlyReview: "on", claudeAllowed: {}, projects: { [f.project]: { mode: "claude" } } });
  f.write("sessions/s1.json", { mode: "off", claudeOnlyReview: "on" });
  for (const mode of ["mixed", "claude", "codex"]) {
    f.settings({ mode, claudeOnlyReview: "off", claudeAllowed: { haiku: ["medium"], sonnet: ["low"], opus: [] } });
    const line = f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext;
    assert.match(line, new RegExp(`^Router: mode=${mode} \\(GSwitch setup\\).*review in claude mode: off`));
    assert.ok(line.endsWith(`Claude workers: haiku medium · sonnet low${mode === "claude" ? "" : " · Speed: normal"}`));
  }
});

test("mode arguments change no setup, config or worker state", (t) => {
  const f = fixture(t); f.mode("mixed");
  f.write("config.json", { default: "claude", extra: "keep" });
  f.write("sessions/s1.json", { mode: "codex", claudeOnlyReview: "off", bindings: { a1: { scope: ["src/*"] } } });
  const files = [f.setupFile, path.join(f.data, "config.json"), path.join(f.data, "sessions/s1.json")];
  const before = files.map((file) => fs.readFileSync(file));
  for (const words of [["codex"], ["off", "do", "task"], ["unknown"], ["it's a \"task\""], [""]]) {
    assert.equal(f.run(["mode", "s1", f.project, ...words]), "Change the setup in GSwitch: Claude Code button.\n");
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  }
  const status = f.run(["mode", "s1", f.project]);
  assert.match(status, /Mixed \(GSwitch setup\).*on \(GSwitch setup\)/);
  assert.match(status, /Claude workers allowed: haiku low, medium/);
  const skill = fs.readFileSync(path.join(plugin, "skills/mode/SKILL.md"), "utf8");
  const injection = skill.match(/!`([^`]+)`/)[1];
  assert.doesNotMatch(injection, /\$0|\$ARGUMENTS/);
  assert.match(skill, /If any arguments were supplied/);
  assert.match(skill, /Change the setup in GSwitch: Claude Code button\./);
  assert.deepEqual(f.agent(), {});
  const state = f.read("sessions/s1.json");
  assert.equal(Object.hasOwn(state, "mode"), false);
  assert.equal(Object.hasOwn(state, "claudeOnlyReview"), false);
  assert.deepEqual(state.bindings.a1.scope, ["src/*"]);
});

test("appDataDir uses the same single-directory validation as dataDir", (t) => {
  const f = fixture(t); f.mode("mixed");
  const copy = path.join(f.home, "plugin"); fs.cpSync(plugin, copy, { recursive: true });
  const entry = path.join(copy, "scripts/router.mjs");
  const target = path.join(copy, "router-target.json");
  for (const appDataDir of [undefined, "..", ".", "../other", "nested/dir", "/absolute", "C:\\outside", 42]) {
    fs.writeFileSync(target, JSON.stringify({ appDataDir }));
    assert.match(f.run(["mode", "s1", f.project], "", entry), /Mixed \(GSwitch setup\)/);
  }
});

test("corrupt claudeAllowed falls back, unknown entries are ignored, empty stays empty", (t) => {
  const f = fixture(t); f.mode("claude");
  for (const claudeAllowed of [undefined, null, [], "all", 5, { haiku: "low" }, { opus: null }, { sonnet: ["high", 42] }]) {
    f.settings({ claudeAllowed });
    assert.equal(f.allowed(), "Claude workers allowed: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max\n");
    assert.deepEqual(f.agent(), {});
    assert.deepEqual(f.agent({ subagent_type: "router:sonnet-low" }), {});
    assert.deepEqual(f.agent({ subagent_type: "router:opus-low" }), {});
  }
  f.setup("{broken");
  assert.deepEqual(f.hook("UserPromptSubmit"), {});
  f.setup({ version: 1, setup: "router", router: { mode: "claude", claudeOnlyReview: "on" } });
  assert.deepEqual(f.agent(), {});
  assert.equal(f.allowed(), "Claude workers allowed: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max\n");
  f.settings({ claudeAllowed: { sonnet: ["max", "bogus", "low", "max"], haiku: ["unknown"], fable: ["low"], unknown: null } });
  assert.equal(f.allowed(), "Claude workers allowed: sonnet low, max\n");
  assert.deepEqual(f.agent({ subagent_type: "router:sonnet-low" }), {});
  assert.match(f.agent({ subagent_type: "router:fable-low" }).hookSpecificOutput.permissionDecisionReason, /use a router worker type/);
  for (const allowed of [{}, { unknown: ["high"] }, { fable: ["max"] }, { fable: null }, { haiku: ["bogus"] }]) {
    f.settings({ claudeAllowed: allowed });
    assert.equal(f.allowed(), "Claude workers allowed: none\n");
    assert.match(f.agent().hookSpecificOutput.permissionDecisionReason, /Allowed: none\./);
  }
});

test("allow-list denies before low usage, after model override and codex mode", (t) => {
  const f = fixture(t); f.mode("claude");
  f.settings({ claudeAllowed: { ...defaultAllowed(), opus: [] } });
  assert.equal(f.agent({ subagent_type: "router:opus-low" }).hookSpecificOutput.permissionDecisionReason,
    "router:opus-low is not allowed. Allowed: haiku low, medium · sonnet low, medium, high, xhigh, max. Pick an allowed worker or send the task to Codex.");
  f.settings({ claudeAllowed: { ...defaultAllowed(), sonnet: ["medium"], opus: [] } });
  assert.deepEqual(f.agent({ subagent_type: "router:sonnet-medium" }, { tool_name: "Task" }), {});
  const pending = f.read("sessions/s1.json").pending.length;
  f.write("usage.json", { fiveHour: { usedPercentage: 80, resetsAt: Date.now() / 1000 + 3600 } });
  assert.match(f.agent({ subagent_type: "router:opus-low" }).hookSpecificOutput.permissionDecisionReason, /is not allowed/);
  assert.match(f.agent({ subagent_type: "router:opus-low", model: "opus" }).hookSpecificOutput.permissionDecisionReason, /model is fixed/);
  f.mode("codex");
  assert.match(f.agent({ subagent_type: "router:opus-low" }).hookSpecificOutput.permissionDecisionReason, /Codex mode denies/);
  assert.equal(f.read("sessions/s1.json").pending.length, pending);
});

test("approval and low usage apply across every generated worker", (t) => {
  const f = fixture(t); f.mode("claude");
  f.settings({ claudeAllowed: Object.fromEntries(models.map(({ short }) => [short, efforts])) });
  for (const { short } of models) for (const effort of efforts) {
    const type = `router:${short}-${effort}`;
    const result = f.agent({ subagent_type: type, description: "Fix parser" });
    const ask = costPerTask[`${short}-${effort}`] > costPerTask["opus-medium"];
    assert.equal(f.decision(result), ask ? "ask" : undefined, type);
    if (ask) assert.equal(result.hookSpecificOutput.permissionDecisionReason, `Approve ${type} for task: Fix parser`);
  }
  assert.equal(f.read("sessions/s1.json").pending.length, workerNames.length);
  f.write("usage.json", { fiveHour: { usedPercentage: 70, resetsAt: Date.now() / 1000 + 3600 } });
  for (const mode of ["mixed", "claude"]) {
    f.mode(mode);
    for (const name of workerNames) {
      const result = f.agent({ subagent_type: `router:${name}` });
      assert.equal(f.decision(result), "deny", name);
      assert.equal(result.hookSpecificOutput.permissionDecisionReason, mode === "mixed" ? "LOW usage: send this to Codex" : "LOW usage: stop and wrap up, ask the owner");
    }
  }
  assert.equal(f.read("sessions/s1.json").pending.length, workerNames.length);
});

test("generated agents check passes and catches drift, missing and extra agents", (t) => {
  const f = fixture(t);
  const generator = path.join(plugin, "scripts/gen-agents.mjs");
  assert.match(f.run(["--check"], "", generator), /checked 15/);
  assert.equal(workerNames.length, 15);
  assert.deepEqual(fs.readdirSync(path.join(plugin, "agents")).sort(), workerNames.map((name) => `${name}.md`).sort());
  const body = fs.readFileSync(path.join(plugin, "templates/worker.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(body.startsWith("<!-- Added by Light505 for gswitchtool (2026). -->\n") && !body.includes("TODO"));
  for (const model of models) for (const effort of efforts) {
    const name = `${model.short}-${effort}`;
    const text = fs.readFileSync(path.join(plugin, "agents", `${name}.md`), "utf8");
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
    assert.ok(text.includes(`description: "Router worker: ${model.display} at ${effort} effort. Started only by the router."\n`));
    assert.ok(text.includes(`model: ${model.id}\neffort: ${effort}\nisolation: worktree\ntools: Read, Edit, Write, Glob, Grep, Bash\n`));
    assert.ok(text.endsWith(`---\n${body}`));
  }
  const copy = path.join(f.home, "plugin"); fs.cpSync(plugin, copy, { recursive: true });
  const entry = path.join(copy, "scripts/gen-agents.mjs");
  const changed = path.join(copy, "agents/sonnet-max.md");
  fs.appendFileSync(changed, "drift\n");
  fs.unlinkSync(path.join(copy, "agents/opus-low.md"));
  fs.writeFileSync(path.join(copy, "agents/extra.md"), "extra\n");
  for (const effort of efforts) fs.writeFileSync(path.join(copy, "agents", `fable-${effort}.md`), "stale\n");
  const failed = spawnSync(process.execPath, [entry, "--check"], { cwd: f.home, env: f.env, encoding: "utf8", windowsHide: true });
  assert.equal(failed.status, 1);
  for (const name of ["sonnet-max", "opus-low", "extra", ...efforts.map((effort) => `fable-${effort}`)]) assert.ok(failed.stderr.includes(`${name}.md`));
  assert.ok(fs.readFileSync(changed, "utf8").endsWith("drift\n"));
  for (const effort of efforts) assert.equal(fs.existsSync(path.join(copy, "agents", `fable-${effort}.md`)), true);
  assert.match(f.run([], "", entry), /generated 15/);
  assert.equal(fs.existsSync(path.join(copy, "agents/extra.md")), false);
  for (const effort of efforts) assert.equal(fs.existsSync(path.join(copy, "agents", `fable-${effort}.md`)), false);
  assert.match(f.run(["--check"], "", entry), /checked 15/);
});

test("Windows keys and slash-safe globs", () => {
  assert.equal(projectKey("C:\\Users\\Me\\project\\", "win32"), "C:/Users/Me/project");
  assert.equal(projectKey("C:/Users/Me/project/../project/", "win32"), "C:/Users/Me/project");
  assert.equal(matchesScope("src/test/a.js", "src\\**"), true);
  assert.equal(matchesScope("src/a.js", "./src/?.js"), true);
  assert.equal(matchesScope("src/nested/a.js", "src/*"), false);
  assert.equal(matchesScope("a.js", "**/*.js"), false);
});

test("corrupt files default safely, malformed hooks allow and log", (t) => {
  const f = fixture(t);
  for (const file of ["config.json", "sessions/s1.json", "usage.json"]) f.write(file, "{broken");
  assert.match(f.run(["mode", "s1", f.project]), /Off.*on/);
  assert.match(f.run(["usage"]), /unknown/);
  assert.deepEqual(f.hook("UserPromptSubmit"), {});
  assert.equal(f.run(["hook", "PreToolUse"], "{bad").trim(), "{}");
  assert.match(fs.readFileSync(path.join(f.data, "router.log"), "utf8"), /PreToolUse:/);
  f.write("config.json", { default: "invalid", projects: [] });
  assert.match(f.run(["mode", "s1", f.project]), /Off/);
});

test("SessionStart cleanup, model warning and pending wrapup in off mode", (t) => {
  const f = fixture(t);
  f.write("sessions/old.json", {}); f.write("sessions/new.json", {});
  fs.utimesSync(path.join(f.data, "sessions/old.json"), new Date(0), new Date(0));
  f.write("sessions/s1.json", { mode: "claude" });
  fs.utimesSync(path.join(f.data, "sessions/s1.json"), new Date(0), new Date(0));
  assert.deepEqual(f.hook("SessionStart", { model: "haiku" }), {});
  assert.equal(fs.existsSync(path.join(f.data, "sessions/old.json")), false);
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  assert.equal(fs.existsSync(path.join(f.data, "sessions/new.json")), true);
  fs.mkdirSync(path.join(f.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(f.home, ".claude", "settings.json"), JSON.stringify({ worktree: { baseRef: "head" } }));
  f.mode("claude");
  assert.match(f.hook("SessionStart", { model: "claude-haiku-5-5" }).hookSpecificOutput.additionalContext, /Opus model/);
  assert.doesNotMatch(f.hook("SessionStart").hookSpecificOutput.additionalContext, /warning/);
  assert.doesNotMatch(f.hook("SessionStart", { model: { id: "claude-opus-5-5" } }).hookSpecificOutput.additionalContext, /warning/);
});

test("UserPromptSubmit exact context and LOW threshold", (t) => {
  const f = fixture(t);
  f.mode("mixed");
  assert.equal(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, "Router: mode=mixed (GSwitch setup) · Codex review in claude mode: on · Use first: codex · Claude 5h: unknown · Claude workers: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max · Speed: normal");
  f.write("usage.json", { fiveHour: { usedPercentage: 70, resetsAt: Date.now() / 1000 + 3600 }, updatedAt: new Date().toISOString() });
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /30% left · LOW: no Claude workers · Claude workers: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max · Speed: normal$/);
  f.settings({ claudeAllowed: { ...defaultAllowed(), sonnet: ["max","low"] } });
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /Claude workers: haiku low, medium · sonnet low, max · opus low, medium, high, xhigh, max · Speed: normal$/);
  f.settings({ claudeAllowed: {} });
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /Claude workers: none · Speed: normal$/);
  f.mode("off"); assert.deepEqual(f.hook("UserPromptSubmit"), {});
});

test("Use first appears only in mixed mode and labels the configured preference", (t) => {
  const f = fixture(t);
  f.settings({ mode: "claude", prefer: "price" });
  assert.doesNotMatch(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /Use first/);
  assert.doesNotMatch(f.hook("SessionStart").hookSpecificOutput.additionalContext, /Use first/);
  assert.doesNotMatch(f.run(["mode", "s1", f.project]), /Use first/);
  assert.doesNotMatch(f.run(["statusline"]), /Use first/);

  f.settings({ mode: "mixed", prefer: "price" });
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /Codex review in claude mode: on · Use first: price · Claude 5h:/);
  assert.match(f.hook("SessionStart").hookSpecificOutput.additionalContext, /Use first: Lowest API price \(GSwitch setup\)/);
  assert.match(f.run(["mode", "s1", f.project]), /Use first: Lowest API price \(GSwitch setup\)/);
  assert.match(f.run(["statusline"]), /Use first: Lowest API price \(GSwitch setup\)/);
});

test("Agent and Task permissions, fixed models, low usage, scope, approval and helpers", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.agent({ subagent_type: "random", model: "haiku" }), {});
  f.mode("mixed");
  assert.equal(f.decision(f.agent({ model: "haiku" })), "deny");
  f.mode("codex"); assert.equal(f.decision(f.agent()), "deny");
  f.mode("mixed");
  f.write("usage.json", { fiveHour: { usedPercentage: 70, resetsAt: Date.now() / 1000 + 3600 } });
  assert.match(f.agent().hookSpecificOutput.permissionDecisionReason, /send this to Codex/);
  f.mode("claude"); assert.match(f.agent().hookSpecificOutput.permissionDecisionReason, /stop and wrap up, ask the owner/);
  f.write("usage.json", { fiveHour: { usedPercentage: 99, resetsAt: Date.now() / 1000 - 1 } });
  assert.equal(f.decision(f.agent({ prompt: "no scope" })), "deny");
  assert.equal(f.decision(f.agent({ prompt: "SCOPE: \nTask" })), "deny");
  f.settings({ claudeAllowed: { ...defaultAllowed(), opus: ["high"] } });
  assert.equal(f.decision(f.agent({ subagent_type: "router:opus-high", description: "Fix parser" })), "ask");
  assert.match(f.agent({ subagent_type: "general-purpose" }).hookSpecificOutput.permissionDecisionReason, /use a router worker type/);
  assert.deepEqual(f.agent({ subagent_type: "Explore" }), {});
  assert.deepEqual(f.agent({ subagent_type: "Plan" }), {});
  assert.deepEqual(f.agent({}, { tool_name: "Task" }), {});
  assert.equal(f.read("sessions/s1.json").pending.length, 2);
});

test("binding oldest matching launch, scope widening, edits, ignored files and finish", (t) => {
  const f = fixture(t); f.init(); f.mode("claude");
  f.agent({ prompt: "SCOPE: src/*" });
  f.agent({ subagent_type: "router:haiku-medium", prompt: "SCOPE: other/*" });
  f.agent({ prompt: "SCOPE: tests/*" });
  f.hook("SubagentStart", { agent_type: "router:haiku-low", agent_id: "a1" });
  assert.deepEqual(f.read("sessions/s1.json").bindings.a1.scope, ["src/*"]);
  assert.equal(f.read("sessions/s1.json").pending.length, 2);
  const edit = (file, agent = "a1", tool_name = "Write") => f.hook("PreToolUse", { agent_id: agent, tool_name, tool_input: { file_path: file } });
  assert.deepEqual(edit("src/a.js"), {});
  assert.deepEqual(edit("src\\a.js", "a1", "Edit"), {});
  assert.deepEqual(edit("ignored/generated.js"), {});
  assert.deepEqual(edit("anywhere.js", "unbound"), {});
  assert.match(edit("other.js").hookSpecificOutput.permissionDecisionReason, /^OUT OF SCOPE: other.js.*SCOPE REQUEST:/);
  assert.equal(f.decision(edit("../outside.js")), "deny");
  assert.equal(f.decision(edit(".git/config")), "deny");
  assert.equal(f.decision(edit("other.js", "a1", "MultiEdit")), "deny");
  assert.equal(f.decision(f.hook("PreToolUse", { agent_id: "a1", tool_name: "NotebookEdit", tool_input: { notebook_path: "book.ipynb" } })), "deny");
  f.run(["scope", "s1", "a1", "--add", "other.js,book.ipynb"]);
  assert.deepEqual(edit("other.js"), {});
  assert.deepEqual(f.hook("PreToolUse", { agent_id: "a1", tool_name: "NotebookEdit", tool_input: { notebook_path: "book.ipynb" } }), {});
  assert.equal(f.decision(f.agent({ subagent_type: "Explore" }, { agent_id: "a1" })), "deny");
  f.hook("SubagentStop", { agent_id: "a1" }); f.hook("SubagentStop", { agent_id: "a1" });
  assert.equal(f.read("sessions/s1.json").finished.length, 1);
  f.mode("off"); assert.deepEqual(edit("outside.js"), {});
});

test("SubagentStart uses app setup and links ignored node and Cargo caches", (t) => {
  const f = fixture(t); f.init();
  fs.writeFileSync(path.join(f.project, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  f.git(["add", "Cargo.toml"]); f.git(["commit", "-m", "cargo"]);
  fs.mkdirSync(path.join(f.project, "node_modules")); fs.mkdirSync(path.join(f.project, "target"));
  const worker = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worker]);
  f.mode("claude"); f.agent();
  f.hook("SubagentStart", { cwd: worker, agent_id: "a1", agent_type: "router:haiku-low" });
  const bound = f.read("sessions/s1.json").bindings.a1;
  assert.equal(bound.cwd, worker);
  for (const name of ["node_modules", "target"]) assert.equal(fs.realpathSync(path.join(worker, name)), fs.realpathSync(path.join(f.project, name)));
  const denied = f.hook("PreToolUse", { cwd: worker, agent_id: "a1", tool_name: "Write", tool_input: { file_path: "file.txt" } });
  assert.equal(f.decision(denied), "deny");
  const escaped = f.hook("PreToolUse", { cwd: worker, agent_id: "a1", tool_name: "Write", tool_input: { file_path: "node_modules/package.js" } });
  assert.equal(f.decision(escaped), "deny");
});

test("concurrent worker launches preserve both records", async (t) => {
  const f = fixture(t); f.mode("claude"); f.plan();
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "hook", "PreToolUse"], { env: f.env, cwd: f.home, windowsHide: true });
    let out = ""; child.stdout.on("data", (chunk) => out += chunk);
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: "s1", cwd: f.project, tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", prompt: "SCOPE: src/*\nTASK: t1" } }));
  });
  await Promise.all([launch(), launch(), launch()]);
  assert.equal(f.read("sessions/s1.json").pending.length, 3);
});

test("statusline captures usage, passes exact stdin/output, removes expired windows", (t) => {
  const f = fixture(t); f.mode("claude");
  const input = { session_id: "s1", cwd: f.project, rate_limits: { five_hour: { used_percentage: 71.5, resets_at: Date.now() / 1000 + 3600 } } };
  assert.match(f.run(["statusline"], input), /Claude only/);
  assert.equal(f.read("usage.json").fiveHour.usedPercentage, 71.5);
  assert.match(f.run(["usage"]), /28.5% left, resets/);
  const passthrough = path.join(f.home, "passthrough.mjs");
  fs.writeFileSync(passthrough, 'import fs from "node:fs"; process.stdout.write(fs.readFileSync(0, "utf8"));');
  f.write("config.json", { statusLineCommand: `"${process.execPath}" "${passthrough}"` });
  const raw = `${JSON.stringify(input)}\n`;
  assert.equal(f.run(["statusline"], raw), raw);
  input.rate_limits.five_hour.resets_at = Date.now() / 1000 - 1;
  f.run(["statusline"], input);
  assert.equal(fs.existsSync(path.join(f.data, "usage.json")), false);
  assert.match(f.run(["usage"]), /unknown/);
  f.write("usage.json", { fiveHour: { usedPercentage: 80, resetsAt: new Date(Date.now() - 10000).toISOString() } });
  f.run(["statusline"], {});
  assert.equal(fs.existsSync(path.join(f.data, "usage.json")), false);
});

test("statusline install/uninstall roundtrip, backups, absent and corrupt settings", (t) => {
  const f = fixture(t);
  f.write("config.json", { default: "codex", claudeOnlyReview: "off", claudeAllowed: {}, projects: {} });
  const file = path.join(f.home, ".claude", "settings.json"); fs.mkdirSync(path.dirname(file));
  const original = { theme: "dark", permissions: { allow: ["Read"] }, statusLine: { type: "command", command: "echo hello", padding: 2 } };
  const raw = JSON.stringify(original, null, 4); fs.writeFileSync(file, raw);
  f.run(["statusline-install"]); f.run(["statusline-install"]);
  assert.deepEqual(Object.keys(f.read("config.json")).sort(), ["statusLineCommand", "statusLinePrevious"]);
  assert.equal(f.read("config.json").statusLineCommand, "echo hello");
  assert.equal(fs.readFileSync(path.join(f.data, "backups", fs.readdirSync(path.join(f.data, "backups"))[0]), "utf8"), raw);
  assert.match(JSON.parse(fs.readFileSync(file, "utf8")).statusLine.command, /router\.mjs.*statusline/);
  f.run(["statusline-uninstall"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
  fs.writeFileSync(file, "{}"); f.run(["statusline-install"]); f.run(["statusline-uninstall"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  fs.writeFileSync(file, "{broken");
  const failed = spawnSync(process.execPath, [script, "statusline-install"], { env: f.env, encoding: "utf8", windowsHide: true });
  assert.notEqual(failed.status, 0); assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("check prints git facts, untracked and binary files, scope and verify output tail", (t) => {
  const f = fixture(t); f.init();
  fs.writeFileSync(path.join(f.project, "file.txt"), "changed\nmore\n");
  fs.writeFileSync(path.join(f.project, "new file.txt"), "new\n");
  fs.writeFileSync(path.join(f.project, "binary.bin"), Buffer.from([0, 255, 3]));
  let out = f.run(["check", "--cwd", f.project, "--scope", "file.txt", "--verify", `"${process.execPath}" -e "process.exit(0)"`]);
  assert.match(out, /Verify: passed/); assert.match(out, /WARNING: changed outside --scope: new file.txt/);
  assert.match(out, /file.txt \(\+2 −1\)/); assert.match(out, /3 files, \+3 −1/);
  out = f.run(["check", "--cwd", f.project, "--verify", `"${process.execPath}" -e "for(let i=0;i<50;i++)console.log('line'+i);process.exit(2)"`]);
  assert.match(out, /Verify: FAILED \(exit 2\)/); assert.match(out, /line10\n/); assert.doesNotMatch(out, /\nline9\n/);
  assert.match(f.run(["check", "--cwd", f.home]), /git: not a repository/);
});

test("apply merges committed, tracked, deleted and binary untracked changes; removes worker branch", (t) => {
  const f = fixture(t); f.init();
  fs.writeFileSync(path.join(f.project, "delete.txt"), "delete me\n");
  f.git(["add", "."]); f.git(["commit", "-m", "deletion fixture"]);
  const worker = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worker]);
  fs.writeFileSync(path.join(worker, "committed.txt"), "committed\n");
  f.git(["add", "."], worker); f.git(["commit", "-m", "worker commit"], worker);
  fs.writeFileSync(path.join(worker, "file.txt"), "worker\n");
  fs.unlinkSync(path.join(worker, "delete.txt"));
  const binary = Buffer.from([0, 255, 128, 3]); fs.writeFileSync(path.join(worker, "binary.bin"), binary);
  for (const name of ["node_modules", "target"]) {
    const source = path.join(f.project, name); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "keep.txt"), "cache");
    fs.symlinkSync(source, path.join(worker, name), process.platform === "win32" ? "junction" : "dir");
  }
  fs.writeFileSync(path.join(f.project, "owner.txt"), "owner\n"); f.git(["add", "owner.txt"]);
  const indexBefore = fs.readFileSync(path.join(f.project, ".git", "index"));
  assert.match(f.run(["apply", "--worktree", worker, "--cwd", f.project]), /Worktree: applied 4 files/);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "worker\n");
  assert.deepEqual(fs.readFileSync(path.join(f.project, "binary.bin")), binary);
  assert.equal(fs.existsSync(path.join(f.project, "delete.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.project, "owner.txt"), "utf8"), "owner\n");
  assert.equal(fs.readFileSync(path.join(f.project, "committed.txt"), "utf8"), "committed\n");
  assert.deepEqual(fs.readFileSync(path.join(f.project, ".git", "index")), indexBefore);
  for (const name of ["node_modules", "target"]) assert.equal(fs.readFileSync(path.join(f.project, name, "keep.txt"), "utf8"), "cache");
  assert.equal(fs.existsSync(worker), false); assert.equal(f.git(["branch", "--list", "worker"]), "");
});

test("apply conflict leaves both worktrees and indexes intact", (t) => {
  const f = fixture(t); f.init();
  const worker = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worker]);
  fs.writeFileSync(path.join(worker, "file.txt"), "worker\n");
  fs.writeFileSync(path.join(f.project, "file.txt"), "owner\n");
  const mainIndex = fs.readFileSync(path.join(f.project, ".git", "index"));
  const workerIndexFile = f.git(["rev-parse", "--git-path", "index"], worker);
  const workerIndex = fs.readFileSync(workerIndexFile);
  assert.match(f.run(["apply", "--worktree", worker, "--cwd", f.project]), /Worktree kept: .*three-way apply conflict/);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "owner\n");
  assert.equal(fs.readFileSync(path.join(worker, "file.txt"), "utf8"), "worker\n");
  assert.deepEqual(fs.readFileSync(path.join(f.project, ".git", "index")), mainIndex);
  assert.deepEqual(fs.readFileSync(workerIndexFile), workerIndex);
  assert.equal(f.git(["branch", "--format=%(refname:short)", "--list", "worker"]), "worker");
});

test("three-way apply retains nonconflicting owner edits in the same file", (t) => {
  const f = fixture(t); f.init();
  const base = "first\n" + "middle\n".repeat(12) + "last\n";
  fs.writeFileSync(path.join(f.project, "file.txt"), base);
  f.git(["add", "."]); f.git(["commit", "-m", "merge fixture"]);
  const worker = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worker]);
  fs.writeFileSync(path.join(worker, "file.txt"), base.replace("first", "worker"));
  fs.writeFileSync(path.join(f.project, "file.txt"), base.replace("last", "owner"));
  assert.match(f.run(["apply", "--worktree", worker, "--cwd", f.project]), /Worktree: applied 1 files/);
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), base.replace("first", "worker").replace("last", "owner"));
});

test("apply rejects foreign repositories and untracked destination collisions", (t) => {
  const f = fixture(t); f.init();
  const foreign = path.join(f.home, "foreign"); fs.mkdirSync(foreign); f.git(["init"], foreign);
  assert.match(f.run(["apply", "--worktree", foreign, "--cwd", f.project]), /Worktree kept: .*same repository/);
  assert.equal(fs.existsSync(foreign), true);
  const worker = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worker]);
  fs.writeFileSync(path.join(worker, "new.txt"), "worker"); fs.writeFileSync(path.join(f.project, "new.txt"), "owner");
  assert.match(f.run(["apply", "--worktree", worker, "--cwd", f.project]), /untracked destination exists/);
  assert.equal(fs.readFileSync(path.join(f.project, "new.txt"), "utf8"), "owner");
});

test("wrapup save/show/clear and off-mode session notice", (t) => {
  const f = fixture(t);
  assert.match(f.run(["wrapup", "show", f.project]), /none/);
  const source = path.join(f.home, "wrapup.json"); fs.writeFileSync(source, JSON.stringify({ tasks: ["parser"], nextSteps: ["verify"] }));
  assert.match(f.run(["wrapup", "save", "s1", f.project, "--file", source]), /saved/);
  assert.deepEqual(JSON.parse(f.run(["wrapup", "show", f.project])).tasks, ["parser"]);
  const notice = f.hook("SessionStart").hookSpecificOutput.additionalContext;
  assert.match(notice, /wrapup show/); assert.doesNotMatch(notice, /Router: Off/);
  f.run(["wrapup", "clear", f.project]); assert.match(f.run(["wrapup", "show", f.project]), /none/);
});

test("Dev build registers both plugins, isolates router state, rewrites Markdown and replaces stale copies", (t) => {
  const f = fixture(t); f.init();
  const builder = path.join(f.project, "scripts", "plugin-dev.mjs");
  fs.mkdirSync(path.join(f.project, "scripts/lib"), { recursive: true });
  fs.copyFileSync(path.join(repository, "scripts/plugin-dev.mjs"), builder);
  fs.copyFileSync(path.join(repository, "scripts/lib/find-claude.mjs"), path.join(f.project, "scripts/lib/find-claude.mjs"));
  fs.copyFileSync(path.join(repository, "scripts/lib/dev-gate.mjs"), path.join(f.project, "scripts/lib/dev-gate.mjs"));
  fs.cpSync(path.join(repository, "integrations/codex-plugin-cc/plugins/codex"), path.join(f.project, "integrations/codex-plugin-cc/plugins/codex"), { recursive: true });
  fs.cpSync(plugin, path.join(f.project, "integrations/router-plugin"), { recursive: true });
  fs.writeFileSync(path.join(f.project, "integrations/router-plugin/references.md"), "codex:gswitch-review and /router:mode");
  fs.writeFileSync(path.join(f.project, "integrations/router-plugin/templates/references.md"), "/router:allow and codex:gswitch-review");
  const result = spawnSync(process.execPath, [builder, "--no-install"], { cwd: f.project, env: f.env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const marketplaceRoot = path.join(f.home, ".gswitchtool-dev-plugin");
  const dev = path.join(marketplaceRoot, "plugins", "router-dev");
  const manifest = JSON.parse(fs.readFileSync(path.join(dev, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "router-dev"); assert.match(manifest.version, /^\d+\.\d+\.\d+-dev\.[a-f0-9]+\.[a-z0-9]+$/);
  const codexManifest = JSON.parse(fs.readFileSync(path.join(marketplaceRoot, "plugins/codex-dev/.claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.version.split("-dev.")[1], codexManifest.version.split("-dev.")[1]);
  const marketplace = JSON.parse(fs.readFileSync(path.join(marketplaceRoot, ".claude-plugin/marketplace.json"), "utf8"));
  assert.deepEqual(marketplace.plugins.map((item) => item.name), ["codex-dev", "router-dev"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dev, "router-target.json"), "utf8")), { $comment: "Added by Light505 for gswitchtool (2026).", dataDir: ".gswitchtool-router-dev", appDataDir: ".gswitchtool-dev" });
  assert.equal(fs.readFileSync(path.join(dev, "references.md"), "utf8"), "codex-dev:gswitch-review and /router-dev:mode");
  assert.equal(fs.readFileSync(path.join(dev, "templates/references.md"), "utf8"), "/router-dev:allow and codex-dev:gswitch-review");
  assert.deepEqual(fs.readdirSync(path.join(dev, "agents")).sort(), workerNames.map((name) => `${name}.md`).sort());
  for (const name of workerNames) assert.equal(fs.readFileSync(path.join(dev, "agents", `${name}.md`), "utf8"), fs.readFileSync(path.join(plugin, "agents", `${name}.md`), "utf8"));
  assert.equal(fs.readFileSync(path.join(dev, "templates/worker.md"), "utf8"), fs.readFileSync(path.join(plugin, "templates/worker.md"), "utf8"));
  for (const name of ["allow", "default", "review"]) assert.equal(fs.existsSync(path.join(dev, "skills", name, "SKILL.md")), false);
  assert.match(f.run(["--check"], "", path.join(dev, "scripts/gen-agents.mjs")), /checked 15/);
  const devScript = path.join(dev, "scripts", "router.mjs");
  const devSetup = path.join(f.home, ".gswitchtool-dev", "claude-setup.json");
  fs.mkdirSync(path.dirname(devSetup), { recursive: true });
  fs.writeFileSync(devSetup, JSON.stringify({ version: 1, setup: "router", router: { mode: "claude", claudeOnlyReview: "off", claudeAllowed: { haiku: ["low"], sonnet: ["max"], opus: ["high"] } } }));
  f.mode("codex");
  assert.match(f.run(["mode", "s1", f.project], "", devScript), /Claude only \(GSwitch setup\).*off/);
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  f.plan(devScript);
  const call = (type) => JSON.parse(f.run(["hook", "PreToolUse"], { session_id: "s1", cwd: f.project, tool_name: "Agent", tool_input: { subagent_type: type, prompt: "SCOPE: src/*\nTASK: t1" } }, devScript));
  assert.deepEqual(call("router-dev:haiku-low"), {});
  assert.equal(fs.existsSync(path.join(f.home, ".gswitchtool-router-dev", "sessions/s1.json")), true);
  assert.deepEqual(call("router:haiku-low"), {});
  assert.equal(call("unknown").hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(f.hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: "router-dev:haiku-low" } }), {});
  assert.deepEqual(f.hook("PreToolUse", { tool_name: "Task", tool_input: { subagent_type: "router-dev:haiku-low" } }), {});
  assert.equal(f.hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: "unknown" } }).hookSpecificOutput.permissionDecision, "deny");
  const bash = (entry, event, command) => JSON.parse(f.run(["hook", event], { session_id: "foreign", cwd: f.project, tool_name: "Bash", tool_input: { command } }, entry));
  for (const slash of ["/", "\\"]) {
    const command = `node "${[".gswitchtool-dev-plugin", "plugins", "codex-dev", "scripts", "codex-companion.mjs"].join(slash)}" invoke --model gpt-6.1-sol --effort low "TASK: unplanned"`;
    fs.mkdirSync(path.join(f.data, "state.lock"), { recursive: true });
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) assert.deepEqual(bash(script, event, command), {});
    fs.rmdirSync(path.join(f.data, "state.lock"));
    assert.equal(fs.existsSync(path.join(f.data, "sessions/foreign.json")), false);
    assert.equal(bash(devScript, "PreToolUse", command).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(bash(devScript, "PostToolUse", command), {});
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, ".gswitchtool-router-dev", "sessions/foreign.json"))).codexLaunches.at(-1).worker, "codex-dev:gpt-6.1-sol/low");
  }
  const devSession = path.join(f.home, ".gswitchtool-router-dev", "sessions/foreign.json");
  const before = fs.readFileSync(devSession, "utf8");
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) assert.deepEqual(bash(devScript, event, 'node "plugins/codex/scripts/codex-companion.mjs" invoke --model gpt-6.1-sol --effort low "TASK: unplanned"'), {});
  assert.equal(fs.readFileSync(devSession, "utf8"), before);
  assert.equal(call("router-dev:sonnet-max").hookSpecificOutput.permissionDecision, "ask");
  assert.equal(call("router-dev:opus-low").hookSpecificOutput.permissionDecision, "deny");
  assert.equal(call("router-dev:opus-high").hookSpecificOutput?.permissionDecision, "ask");
  fs.writeFileSync(path.join(dev, "stale.md"), "stale");
  const rerun = spawnSync(process.execPath, [builder, "--no-install"], { cwd: f.project, env: f.env, encoding: "utf8", windowsHide: true });
  assert.equal(rerun.status, 0, rerun.stderr); assert.equal(fs.existsSync(path.join(dev, "stale.md")), false);
  assert.match(fs.readFileSync(path.join(dev, "skills/mode/SKILL.md"), "utf8"), /disable-model-invocation: true/);
});

test("Codex Speed normalizes setup and appears only in Codex modes", (t) => {
  const f = fixture(t);
  const plan = () => f.run(["plan", "s1", f.project, "--task", "speed", "--kind", "implement", "--difficulty", "small"]);
  const setup = (mode, codexSpeed) => f.setup({ version: 1, setup: "router", router: { mode, claudeOnlyReview: "on" }, codexSpeed });
  for (const value of [undefined, null, [], {}, { mode: "invalid", fastMinRemaining: 20 }]) {
    assert.deepEqual(normalizeCodexSpeed(value), { mode: "normal", fastMinRemaining: 20 });
    setup("mixed", value);
    assert.match(f.run(["mode", "s1", f.project]), / · Speed: Normal \(GSwitch setup\)/);
    assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, / · Speed: normal$/);
    assert.doesNotMatch(plan(), /Codex speed:/);
  }
  for (const [value, expected] of [
    [{ mode: "orchestrator" }, { mode: "orchestrator", fastMinRemaining: 20 }],
    [{ mode: "fast", fastMinRemaining: 20.5 }, { mode: "fast", fastMinRemaining: 20 }],
    [{ mode: "bogus", fastMinRemaining: 35 }, { mode: "normal", fastMinRemaining: 35 }],
    ...[-1, 91, "20", undefined].map((fastMinRemaining) =>
      [{ mode: "fast", fastMinRemaining }, { mode: "fast", fastMinRemaining: 20 }])
  ]) {
    assert.deepEqual(normalizeCodexSpeed(value), expected);
    setup("mixed", value);
    assert.ok(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext.endsWith(` · Speed: ${expected.mode}`));
    if (expected.mode === "normal") assert.doesNotMatch(plan(), /Codex speed:/);
    else assert.ok(plan().includes(`below ${expected.fastMinRemaining}% usage left`));
  }
  for (const mode of ["mixed", "codex", "claude"]) for (const speed of ["normal", "fast", "orchestrator"]) {
    setup(mode, { mode: speed, fastMinRemaining: 35 });
    const output = plan();
    const line = f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext;
    const status = f.run(["statusline"]);
    if (mode === "claude") {
      assert.doesNotMatch(line + status + output, /Speed:|Codex speed:/); continue;
    }
    assert.ok(line.endsWith(` · Speed: ${speed}`));
    const label = { normal: "Normal", fast: "Fast", orchestrator: "Orchestrator decides" }[speed];
    assert.ok(status.includes(` · Speed: ${label} (GSwitch setup)`));
    if (speed === "normal") assert.doesNotMatch(output, /Codex speed:/);
    else if (speed === "fast") assert.ok(output.includes("Codex speed: Fast (falls back to Normal below 35% usage left)"));
    else assert.ok(output.includes('Codex speed: Orchestrator decides — add --speed fast --speed-reason "<why>" only when the owner is waiting on this result to continue; otherwise Normal. Fast falls back to Normal below 35% usage left.'));
  }
  for (const cutoff of [0, 90]) {
    setup("codex", { mode: "fast", fastMinRemaining: cutoff });
    assert.ok(plan().includes(`below ${cutoff}% usage left`));
  }
});
