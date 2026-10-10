// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));
const TOKEN = "check-token";
const setup = (name, mode = "mixed") => ({ version: 1, setup: name,
  router: { mode, claudeOnlyReview: "on", claudeAllowed: { haiku: ["low"], sonnet: [], opus: [] } } });

// A fake GSwitch endpoint that answers "status" with the given fields.
async function fixture(t, { running = true, status = {}, setupValue = setup("router"), routerInstalled = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "check-"));
  const dir = path.join(home, ".gswitchtool");
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (setupValue) fs.writeFileSync(path.join(dir, "claude-setup.json"), JSON.stringify(setupValue));
  if (routerInstalled) {
    fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "router@gswitchtool": [{ version: "1.2.3" }] } }));
  }
  if (running) {
    const endpoint = process.platform === "win32" ? path.join("\\\\.\\pipe", `check-${randomUUID()}`) : path.join(dir, "invoke.sock");
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        const request = JSON.parse(chunk.split("\n")[0]);
        socket.write(`${JSON.stringify({ id: request.id, result: { invoke_mode: true, codex_signed_out: false, allowed_accounts: 2, ...status } })}\n`);
      });
    });
    await new Promise((resolve) => server.listen(endpoint, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    fs.writeFileSync(path.join(dir, "invoke-endpoint.json"), JSON.stringify({ endpoint, token: TOKEN, pid: process.pid }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, GSWITCH_CONFIG_DIR: dir };
  const check = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "check"], { env, cwd: home, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => { assert.equal(code, 0, stderr); assert.equal(stderr, ""); resolve(stdout); });
  });
  return { check };
}

test("check: all set", async (t) => {
  const out = await (await fixture(t, { routerInstalled: true })).check();
  assert.match(out, /✓ GSwitch app running/);
  assert.match(out, /✓ Claude Code setup: Automatic team \(Claude and Codex\)/);
  assert.match(out, /✓ Codex plugin \d/);
  assert.match(out, /✓ Router plugin 1\.2\.3/);
  assert.match(out, /✓ Codex signed in/);
  assert.match(out, /✓ 2 accounts Claude may use/);
  assert.match(out, /✓ Codex helper: on/);
  assert.match(out, /All set\.\n$/);
  assert.doesNotMatch(out, /✗/);
});

test("check: GSwitch not running still shows setup and plugins", async (t) => {
  const out = await (await fixture(t, { running: false })).check();
  assert.match(out, /✗ GSwitch app not running\. Open GSwitch\./);
  assert.match(out, /✓ Claude Code setup: Automatic team/);
  assert.match(out, /✓ Codex plugin/);
  assert.match(out, /✗ Router plugin not installed/);
  assert.match(out, /– Codex sign-in. needs GSwitch running/);
  assert.match(out, /– Accounts Claude may use. needs GSwitch running/);
  assert.match(out, /Fix the ✗ items above, then run \/codex:check again\.\n$/);
});

test("check: missing setup file", async (t) => {
  const out = await (await fixture(t, { setupValue: null })).check();
  assert.match(out, /✗ Claude Code setup: not found\. Open GSwitch once so it writes its setup\./);
});

test("check: router needed but missing", async (t) => {
  const out = await (await fixture(t)).check();
  assert.match(out, /✗ Router plugin not installed\. In Claude Code: \/plugin install router@gswitchtool, then restart Claude Code/);
  assert.match(out, /Fix the ✗ items above/);
});

test("check: router not needed", async (t) => {
  const out = await (await fixture(t, { setupValue: setup("claude-codex") })).check();
  assert.match(out, /– Router plugin: not needed for this setup/);
  assert.match(out, /All set\./);
});

test("check: Codex not used by the setup", async (t) => {
  const out = await (await fixture(t, { setupValue: setup("claude-only") })).check();
  assert.match(out, /– Codex sign-in/);
  assert.match(out, /– Accounts Claude may use/);
  assert.match(out, /All set\./);
});

test("check: no allowed accounts, signed out and paused are flagged", async (t) => {
  const none = await (await fixture(t, { routerInstalled: true, status: { allowed_accounts: 0 } })).check();
  assert.match(none, /✗ No account is allowed\. In GSwitch, open Accounts and turn on Claude may use this account\./);
  const out = await (await fixture(t, { routerInstalled: true, status: { codex_signed_out: true, paused: { resumes_at: null } } })).check();
  assert.match(out, /✗ Codex is signed out\. Sign in to Codex in GSwitch\./);
  assert.match(out, /✗ Codex helper: paused\. Codex usage ran out on every allowed account; choose Resume in GSwitch\./);
  const off = await (await fixture(t, { routerInstalled: true, status: { invoke_mode: false } })).check();
  assert.match(off, /✗ Codex helper: off\. In GSwitch → Claude Code, choose Claude with Codex helper or Automatic team, then save\./);
});

test("check: output contains no email addresses", async (t) => {
  const out = await (await fixture(t, { routerInstalled: true, status: { accounts: [{ email: "someone@example.com", name: "Someone" }] } })).check();
  assert.doesNotMatch(out, /example\.com|Someone/);
  assert.doesNotMatch(out, /\S+@\S+\.\S+/);
});
