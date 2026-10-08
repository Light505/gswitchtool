// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectKey } from "../scripts/router.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(plugin, "scripts", "router.mjs");
const baseRefWarning = 'Router warning: set "worktree": { "baseRef": "head" } in .claude/settings.local.json so workers start from your current branch.';
const notRepository = (folder) => `Router warning: ${projectKey(folder)} is not a git repository; start the session in the repository folder.`;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const data = path.join(home, ".gswitchtool-router");
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  const run = (args, input = "") => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: home, env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const hook = (event, extra = {}) => JSON.parse(run(["hook", event], { session_id: "s1", cwd: project, ...extra }));
  const mode = (value, folder = project) => {
    const file = path.join(home, ".gswitchtool", "claude-setup.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, setup: value === "off" ? "claude-only" : "router", router: { mode: value === "off" ? "mixed" : value, claudeOnlyReview: "on" } }));
    return run(["mode", "s1", folder]);
  };
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
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const read = (relative) => JSON.parse(fs.readFileSync(path.join(data, relative), "utf8"));
  return { home, env, data, project, run, hook, mode, git, init, write, read };
}

test("a session folder outside git does not break worker dependency links and mode warns", (t) => {
  const f = fixture(t); f.init();
  const folder = path.join(f.home, "scratch"); fs.mkdirSync(folder);
  const worker = path.join(f.home, "worker");
  f.git(["worktree", "add", "-b", "w1", worker]);
  fs.mkdirSync(path.join(f.project, "node_modules"));
  assert.equal(f.mode("mixed", folder).split("\n")[2], notRepository(folder));
  assert.deepEqual(f.hook("SubagentStart", { agent_type: "router:haiku-low", agent_id: "a1", cwd: worker }), {});
  assert.equal(fs.existsSync(path.join(worker, "node_modules")), true);
  assert.equal(fs.existsSync(path.join(f.data, "router.log")), false);
});

test("mode and SessionStart warn when worktree.baseRef is not head; later settings win, unreadable files are ignored", (t) => {
  const f = fixture(t); f.init();
  const user = path.join(f.home, ".claude", "settings.json");
  const local = path.join(f.project, ".claude", "settings.local.json");
  const project = path.join(f.project, ".claude", "settings.json");
  assert.equal(f.mode("off").includes(baseRefWarning), false);
  assert.equal(f.mode("mixed").includes(baseRefWarning), true);
  f.write(user, JSON.stringify({ worktree: { baseRef: "head" } }));
  assert.equal(f.mode("mixed").includes(baseRefWarning), false);
  f.write(local, JSON.stringify({ worktree: { baseRef: "origin" } }));
  assert.equal(f.mode("mixed").includes(baseRefWarning), true);
  f.write(local, JSON.stringify({ worktree: { baseRef: "head" } }));
  assert.equal(f.mode("mixed").includes(baseRefWarning), false);
  f.write(local, "{broken");
  f.write(project, JSON.stringify({ worktree: { baseRef: "head" } }));
  assert.equal(f.mode("mixed").includes(baseRefWarning), false);
  f.write(project, JSON.stringify({ worktree: { baseRef: "origin" } }));
  fs.rmSync(local, { force: true });
  assert.equal(f.mode("mixed").includes(baseRefWarning), true);
  f.write(local, JSON.stringify({ worktree: { baseRef: "head" } }));
  // SessionStart: same rule, only when the mode is not off.
  const context = () => f.hook("SessionStart", { model: "claude-opus-5", cwd: f.project }).hookSpecificOutput.additionalContext;
  assert.equal(context().includes(baseRefWarning), false);
  f.write(local, JSON.stringify({ worktree: { baseRef: "origin" } }));
  assert.equal(context().includes(baseRefWarning), true);
  f.mode("off");
  assert.equal(f.hook("SessionStart", { model: "claude-opus-5", cwd: f.project }).hookSpecificOutput, undefined);
});

test("mode warns about a folder outside git only", (t) => {
  const f = fixture(t); f.init();
  assert.equal(f.mode("off").includes("is not a git repository"), false);
  const folder = path.join(f.home, "scratch"); fs.mkdirSync(folder);
  assert.deepEqual(f.mode("mixed", folder).trimEnd().split("\n").slice(2), [notRepository(folder), baseRefWarning]);
});

test("identical copied settings are not worker changes in check or apply", (t) => {
  const f = fixture(t); f.init();
  const worker = path.join(f.home, "worker");
  f.git(["worktree", "add", "-b", "w1", worker]);
  const settings = '{"permissions":{}}\n';
  const copy = path.join(worker, ".claude", "settings.local.json");
  f.write(path.join(f.project, ".claude", "settings.local.json"), settings);
  f.write(copy, settings);
  f.write(path.join(worker, "file.txt"), "changed\n");
  const output = f.run(["check", "--cwd", worker, "--scope", "file.txt"]);
  assert.doesNotMatch(output, /settings\.local|WARNING/);
  assert.match(output, /file\.txt \(\+1 −1\)/);
  // The main worktree itself skips nothing.
  assert.match(f.run(["check", "--cwd", f.project, "--scope", "file.txt"]), /WARNING: changed outside --scope: \.claude\/settings\.local\.json/);
  f.write(copy, '{"changed":true}\n');
  assert.match(f.run(["check", "--cwd", worker, "--scope", "file.txt"]), /WARNING: changed outside --scope: \.claude\/settings\.local\.json/);
  f.write(copy, settings);
  assert.equal(f.run(["apply", "--worktree", worker, "--cwd", f.project]), "Worktree: applied 1 files\n");
  assert.equal(fs.readFileSync(path.join(f.project, "file.txt"), "utf8"), "changed\n");
  assert.equal(fs.readFileSync(path.join(f.project, ".claude", "settings.local.json"), "utf8"), settings);
  assert.equal(fs.existsSync(worker), false);
});

test("statusline install replaces a router command from an older plugin path without saving it", (t) => {
  const f = fixture(t);
  const file = path.join(f.home, ".claude", "settings.json");
  const old = 'node "C:/old-plugin/scripts/router.mjs" statusline';
  f.write(file, JSON.stringify({ statusLine: { type: "command", command: "echo hello" } }));
  f.run(["statusline-install"]);
  f.write(file, JSON.stringify({ statusLine: { type: "command", command: old } }));
  f.run(["statusline-install"]);
  const command = JSON.parse(fs.readFileSync(file, "utf8")).statusLine.command;
  assert.match(command, /router\.mjs" statusline$/);
  assert.notEqual(command, old);
  assert.equal(f.run(["statusline-install"]), "Router status line already installed\n");
  assert.equal(f.read("config.json").statusLineCommand, "echo hello");
  assert.deepEqual(f.read("config.json").statusLinePrevious, { type: "command", command: "echo hello" });
  f.run(["statusline-uninstall"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { statusLine: { type: "command", command: "echo hello" } });
});
