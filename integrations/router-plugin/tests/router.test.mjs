// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectKey, matchesScope } from "../scripts/router.mjs";
import { models, efforts, workerNames, defaultAllowed } from "../scripts/workers.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(plugin, "../..");
const script = path.join(plugin, "scripts", "router.mjs");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
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
  const mode = (value) => run(["mode", "s1", project, value]);
  const agent = (extra = {}, top = {}) => hook("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", prompt: "Do work\nSCOPE: src/*", ...extra }, ...top });
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
  return { home, env, data, project, run, write, read, hook, mode, agent, decision, git, init };
}

test("mode and review resolve session > project > global, task words ignored", (t) => {
  const f = fixture(t);
  assert.match(f.run(["mode", "s1", f.project]), /Off \(global default\).*on \(global default\)/);
  f.run(["default", f.project, "mixed", "--all"]);
  assert.match(f.run(["mode", "s1", f.project]), /Mixed \(global default\)/);
  f.run(["default", f.project, "claude"]);
  f.run(["default", f.project, "review", "off"]);
  assert.match(f.run(["mode", "s1", f.project, "do", "task"]), /Claude only \(project default\).*off \(project default\)/);
  assert.match(f.run(["mode", "s1", f.project, "codex", "do", "task"]), /Codex only \(session\)/);
  assert.match(f.run(["review", "s1", f.project, "on"]), /on \(session\)/);
  f.run(["default", f.project, "--clear"]);
  assert.match(f.run(["mode", "s2", f.project]), /Mixed \(global default\).*on \(global default\)/);
  f.run(["default", f.project, "review", "off", "--all"]);
  assert.match(f.run(["mode", "s2", f.project]), /off \(global default\)/);
  f.run(["default", f.project, "--clear", "--all"]);
  assert.equal(f.read("config.json").default, "off");
  assert.equal(f.read("config.json").claudeOnlyReview, "on");
  assert.deepEqual(f.read("config.json").projects, {});
});

test("allow shows, replaces, orders, enables all, disables and resets globally", (t) => {
  const f = fixture(t);
  const defaults = "Claude workers allowed: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max\n";
  assert.equal(f.run(["allow"]), defaults);
  assert.equal(fs.existsSync(path.join(f.data, "config.json")), false);
  f.write("config.json", { default: "claude", projects: { [projectKey(f.project)]: { claudeAllowed: { sonnet: ["max"] } } }, extra: "keep" });
  assert.equal(f.run(["allow"]), defaults);
  assert.equal(f.run(["allow", "sonnet", "high,low,high"]), "Claude workers allowed: haiku low, medium · sonnet low, high · opus low, medium, high, xhigh, max\n");
  assert.deepEqual(f.read("config.json").claudeAllowed.sonnet, ["low", "high"]);
  f.run(["allow", "sonnet", "medium"]);
  assert.deepEqual(f.read("config.json").claudeAllowed.sonnet, ["medium"]);
  f.run(["allow", "opus", "all"]);
  assert.deepEqual(f.read("config.json").claudeAllowed.opus, efforts);
  assert.match(f.run(["allow"]), /sonnet medium · opus low, medium, high, xhigh, max/);
  for (const { short } of models) f.run(["allow", short, "none"]);
  assert.equal(f.run(["allow"]), "Claude workers allowed: none\n");
  assert.equal(f.run(["allow", "--reset"]), defaults);
  const cfg = f.read("config.json");
  assert.deepEqual(cfg.claudeAllowed, defaultAllowed());
  assert.equal(cfg.default, "claude"); assert.equal(cfg.extra, "keep");
  assert.deepEqual(cfg.projects[projectKey(f.project)].claudeAllowed, { sonnet: ["max"] });
});

test("bad allow input names valid values and leaves config bytes unchanged", (t) => {
  const f = fixture(t);
  const invalid = [
    ["unknown", "low"], ["fable", "all"], ["haiku", "ultra"], ["opus"], ["sonnet", "low,"],
    ["sonnet", ""], ["haiku", "all,low"], ["haiku", "none,low"],
    ["haiku", "low", "extra"], ["--reset", "extra"]
  ];
  for (const raw of [null, "{broken", JSON.stringify({ claudeAllowed: { sonnet: ["max"] }, extra: "keep" }, null, 4)]) {
    if (raw !== null) f.write("config.json", raw);
    for (const args of invalid) {
      const result = spawnSync(process.execPath, [script, "allow", ...args], { cwd: f.home, env: f.env, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, ""); assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
      if (["unknown", "fable", "--reset"].includes(args[0])) assert.equal(result.stderr, "Router: Invalid model. Valid models: haiku, sonnet, opus\n");
      else assert.match(result.stderr, /Valid efforts: low, medium, high, xhigh, max/);
      if (raw === null) assert.equal(fs.existsSync(path.join(f.data, "config.json")), false);
      else assert.equal(fs.readFileSync(path.join(f.data, "config.json"), "utf8"), raw);
    }
  }
});

test("corrupt claudeAllowed falls back, unknown entries are ignored, empty stays empty", (t) => {
  const f = fixture(t); f.mode("claude");
  for (const claudeAllowed of [undefined, null, [], "all", 5, { haiku: "low" }, { opus: null }, { sonnet: ["high", 42] }]) {
    f.write("config.json", { claudeAllowed });
    assert.equal(f.run(["allow"]), "Claude workers allowed: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max\n");
    assert.deepEqual(f.agent(), {});
    assert.deepEqual(f.agent({ subagent_type: "router:sonnet-low" }), {});
    assert.deepEqual(f.agent({ subagent_type: "router:opus-low" }), {});
  }
  f.write("config.json", "{broken");
  assert.deepEqual(f.agent(), {});
  assert.equal(f.run(["allow"]), "Claude workers allowed: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max\n");
  f.write("config.json", { claudeAllowed: { sonnet: ["max", "bogus", "low", "max"], haiku: ["unknown"], fable: ["low"], unknown: null } });
  assert.equal(f.run(["allow"]), "Claude workers allowed: sonnet low, max\n");
  assert.deepEqual(f.agent({ subagent_type: "router:sonnet-low" }), {});
  assert.match(f.agent({ subagent_type: "router:fable-low" }).hookSpecificOutput.permissionDecisionReason, /use a router worker type/);
  for (const allowed of [{}, { unknown: ["high"] }, { fable: ["max"] }, { fable: null }, { haiku: ["bogus"] }]) {
    f.write("config.json", { claudeAllowed: allowed });
    assert.equal(f.run(["allow"]), "Claude workers allowed: none\n");
    assert.match(f.agent().hookSpecificOutput.permissionDecisionReason, /Allowed: none\./);
  }
});

test("allow-list denies before low usage, after model override and codex mode", (t) => {
  const f = fixture(t); f.mode("claude");
  f.run(["allow", "opus", "none"]);
  assert.equal(f.agent({ subagent_type: "router:opus-low" }).hookSpecificOutput.permissionDecisionReason,
    "router:opus-low is not allowed. Allowed: haiku low, medium · sonnet low, medium, high, xhigh, max. Pick an allowed worker or send the task to Codex.");
  f.run(["allow", "sonnet", "medium"]);
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
  for (const { short } of models) f.run(["allow", short, "all"]);
  for (const { short } of models) for (const effort of efforts) {
    const type = `router:${short}-${effort}`;
    const result = f.agent({ subagent_type: type, description: "Fix parser" });
    const ask = (short === "sonnet" && effort === "max") || (short === "opus" && ["high", "xhigh", "max"].includes(effort));
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

test("Windows keys, slash-safe globs and project lookup", (t) => {
  assert.equal(projectKey("C:\\Users\\Me\\project\\", "win32"), "C:/Users/Me/project");
  assert.equal(projectKey("C:/Users/Me/project/../project/", "win32"), "C:/Users/Me/project");
  assert.equal(matchesScope("src/test/a.js", "src\\**"), true);
  assert.equal(matchesScope("src/a.js", "./src/?.js"), true);
  assert.equal(matchesScope("src/nested/a.js", "src/*"), false);
  assert.equal(matchesScope("a.js", "**/*.js"), false);
  const f = fixture(t);
  f.run(["default", `${f.project}${path.sep}`, "claude"]);
  assert.equal(Object.keys(f.read("config.json").projects)[0], projectKey(f.project));
  if (process.platform === "win32") {
    assert.match(f.run(["mode", "s1", f.project.toUpperCase().replaceAll("\\", "/")]), /Claude only \(project default\)/);
    f.run(["default", f.project.toUpperCase(), "review", "off"]);
    assert.equal(Object.keys(f.read("config.json").projects).length, 1);
  }
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
  f.mode("claude");
  assert.match(f.hook("SessionStart", { model: "claude-haiku-5-5" }).hookSpecificOutput.additionalContext, /Opus model/);
  assert.doesNotMatch(f.hook("SessionStart").hookSpecificOutput.additionalContext, /warning/);
  assert.doesNotMatch(f.hook("SessionStart", { model: { id: "claude-opus-5-5" } }).hookSpecificOutput.additionalContext, /warning/);
});

test("UserPromptSubmit exact context and LOW threshold", (t) => {
  const f = fixture(t);
  f.mode("mixed");
  assert.equal(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, "Router: mode=mixed (session) · Codex review in claude mode: on · Claude 5h: unknown · Claude workers: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max");
  f.write("usage.json", { fiveHour: { usedPercentage: 70, resetsAt: Date.now() / 1000 + 3600 }, updatedAt: new Date().toISOString() });
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /30% left · LOW: no Claude workers · Claude workers: haiku low, medium · sonnet low, medium, high, xhigh, max · opus low, medium, high, xhigh, max$/);
  f.run(["allow", "sonnet", "max,low"]);
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /Claude workers: haiku low, medium · sonnet low, max · opus low, medium, high, xhigh, max$/);
  f.write("config.json", { claudeAllowed: {} });
  assert.match(f.hook("UserPromptSubmit").hookSpecificOutput.additionalContext, /Claude workers: none$/);
  f.mode("off"); assert.deepEqual(f.hook("UserPromptSubmit"), {});
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
  f.run(["allow", "opus", "high"]);
  assert.equal(f.decision(f.agent({ subagent_type: "router:opus-high", description: "Fix parser" })), "ask");
  assert.match(f.agent({ subagent_type: "router:opus-high", description: "Fix parser" }).hookSpecificOutput.permissionDecisionReason, /Fix parser/);
  assert.match(f.agent({ subagent_type: "general-purpose" }).hookSpecificOutput.permissionDecisionReason, /use a router worker type/);
  assert.deepEqual(f.agent({ subagent_type: "Explore" }), {});
  assert.deepEqual(f.agent({ subagent_type: "Plan" }), {});
  assert.deepEqual(f.agent({}, { tool_name: "Task" }), {});
  assert.equal(f.read("sessions/s1.json").pending.length, 3);
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

test("SubagentStart inherits project mode and links ignored node and Cargo caches", (t) => {
  const f = fixture(t); f.init();
  fs.writeFileSync(path.join(f.project, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  f.git(["add", "Cargo.toml"]); f.git(["commit", "-m", "cargo"]);
  fs.mkdirSync(path.join(f.project, "node_modules")); fs.mkdirSync(path.join(f.project, "target"));
  const worker = path.join(f.home, "worker"); f.git(["worktree", "add", "-b", "worker", worker]);
  f.run(["default", f.project, "claude"]); f.agent();
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
  const f = fixture(t); f.mode("claude");
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "hook", "PreToolUse"], { env: f.env, cwd: f.home, windowsHide: true });
    let out = ""; child.stdout.on("data", (chunk) => out += chunk);
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify({ session_id: "s1", cwd: f.project, tool_name: "Agent", tool_input: { subagent_type: "router:haiku-low", prompt: "SCOPE: src/*" } }));
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
  const file = path.join(f.home, ".claude", "settings.json"); fs.mkdirSync(path.dirname(file));
  const original = { theme: "dark", permissions: { allow: ["Read"] }, statusLine: { type: "command", command: "echo hello", padding: 2 } };
  const raw = JSON.stringify(original, null, 4); fs.writeFileSync(file, raw);
  f.run(["statusline-install"]); f.run(["statusline-install"]);
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
  fs.cpSync(path.join(repository, "integrations/codex-plugin-cc/plugins/codex"), path.join(f.project, "integrations/codex-plugin-cc/plugins/codex"), { recursive: true });
  fs.cpSync(plugin, path.join(f.project, "integrations/router-plugin"), { recursive: true });
  fs.writeFileSync(path.join(f.project, "integrations/router-plugin/references.md"), "codex:gswitch-review and /router:mode");
  fs.writeFileSync(path.join(f.project, "integrations/router-plugin/templates/references.md"), "/router:allow and codex:gswitch-review");
  const result = spawnSync(process.execPath, [builder, "--no-install"], { cwd: f.project, env: f.env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const marketplaceRoot = path.join(f.home, ".gswitchtool-dev-plugin");
  const dev = path.join(marketplaceRoot, "plugins", "router-dev");
  const manifest = JSON.parse(fs.readFileSync(path.join(dev, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "router-dev"); assert.match(manifest.version, /^0\.1\.0-dev\.[a-f0-9]+\.[a-z0-9]+$/);
  const codexManifest = JSON.parse(fs.readFileSync(path.join(marketplaceRoot, "plugins/codex-dev/.claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.version.split("-dev.")[1], codexManifest.version.split("-dev.")[1]);
  const marketplace = JSON.parse(fs.readFileSync(path.join(marketplaceRoot, ".claude-plugin/marketplace.json"), "utf8"));
  assert.deepEqual(marketplace.plugins.map((item) => item.name), ["codex-dev", "router-dev"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dev, "router-target.json"), "utf8")), { dataDir: ".gswitchtool-router-dev" });
  assert.equal(fs.readFileSync(path.join(dev, "references.md"), "utf8"), "codex-dev:gswitch-review and /router-dev:mode");
  assert.equal(fs.readFileSync(path.join(dev, "templates/references.md"), "utf8"), "/router-dev:allow and codex-dev:gswitch-review");
  assert.deepEqual(fs.readdirSync(path.join(dev, "agents")).sort(), workerNames.map((name) => `${name}.md`).sort());
  for (const name of workerNames) assert.equal(fs.readFileSync(path.join(dev, "agents", `${name}.md`), "utf8"), fs.readFileSync(path.join(plugin, "agents", `${name}.md`), "utf8"));
  assert.equal(fs.readFileSync(path.join(dev, "templates/worker.md"), "utf8"), fs.readFileSync(path.join(plugin, "templates/worker.md"), "utf8"));
  assert.match(fs.readFileSync(path.join(dev, "skills/allow/SKILL.md"), "utf8"), /disable-model-invocation: true/);
  assert.match(f.run(["--check"], "", path.join(dev, "scripts/gen-agents.mjs")), /checked 15/);
  const devScript = path.join(dev, "scripts", "router.mjs");
  f.run(["mode", "s1", f.project, "claude"], "", devScript);
  assert.equal(fs.existsSync(path.join(f.home, ".gswitchtool-router-dev", "sessions/s1.json")), true);
  assert.equal(fs.existsSync(path.join(f.data, "sessions/s1.json")), false);
  const call = (type) => JSON.parse(f.run(["hook", "PreToolUse"], { session_id: "s1", cwd: f.project, tool_name: "Agent", tool_input: { subagent_type: type, prompt: "SCOPE: src/*" } }, devScript));
  assert.deepEqual(call("router-dev:haiku-low"), {});
  assert.equal(call("router:haiku-low").hookSpecificOutput.permissionDecision, "deny");
  f.run(["allow", "sonnet", "max"], "", devScript);
  assert.equal(call("router-dev:sonnet-max").hookSpecificOutput.permissionDecision, "ask");
  f.run(["allow", "opus", "high"], "", devScript);
  assert.equal(call("router-dev:opus-low").hookSpecificOutput.permissionDecision, "deny");
  assert.equal(call("router-dev:opus-high").hookSpecificOutput.permissionDecision, "ask");
  fs.writeFileSync(path.join(dev, "stale.md"), "stale");
  const rerun = spawnSync(process.execPath, [builder, "--no-install"], { cwd: f.project, env: f.env, encoding: "utf8", windowsHide: true });
  assert.equal(rerun.status, 0, rerun.stderr); assert.equal(fs.existsSync(path.join(dev, "stale.md")), false);
  assert.match(fs.readFileSync(path.join(dev, "skills/mode/SKILL.md"), "utf8"), /disable-model-invocation: true/);
});
