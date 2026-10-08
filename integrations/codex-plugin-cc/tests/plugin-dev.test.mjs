// Modified by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generator = path.join(root, "scripts", "plugin-dev.mjs");

test("plugin:dev builds an isolated, rewritten copy and replaces it on rerun", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "gswitch-plugin-dev-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const run = () => execFileSync(process.execPath, [generator, "--no-install"], { cwd: root, env, stdio: "pipe" });
  const plugin = path.join(home, ".gswitchtool-dev-plugin", "plugins", "codex-dev");
  run();

  const manifest = JSON.parse(readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "codex-dev");
  assert.match(manifest.version, /-dev\.[a-f0-9]+\.[a-z0-9]+$/);
  assert.match(manifest.description, /^\[dev\] /);
  assert.deepEqual(JSON.parse(readFileSync(path.join(plugin, "gswitch-target.json"), "utf8")), {
    dataDir: ".gswitchtool-dev",
    appName: "GSwitch Claude Tool (Dev)"
  });
  const marketplace = JSON.parse(readFileSync(path.join(home, ".gswitchtool-dev-plugin", ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "gswitchtool-dev");
  assert.equal(marketplace.plugins[0].name, "codex-dev");
  assert.equal(marketplace.plugins[0].source, "./plugins/codex-dev");

  assert.deepEqual(JSON.parse(readFileSync(path.join(home, ".gswitchtool-dev-plugin/plugins/router-dev/router-target.json"), "utf8")), { $comment: "Added by Light505 for gswitchtool (2026).", dataDir: ".gswitchtool-router-dev", appDataDir: ".gswitchtool-dev" });

  const invoke = readFileSync(path.join(plugin, "skills", "gswitch-review", "SKILL.md"), "utf8");
  assert.match(invoke, /\/codex-dev:/);
  assert.doesNotMatch(invoke, /\/codex:/);
  const review = readFileSync(path.join(plugin, "skills", "gswitch-review", "SKILL.md"), "utf8");
  assert.match(review.split("---")[1], /disable-model-invocation:\s*true/);
  assert.match(review, /only when the user types \/codex-dev:gswitch-review/);
  const installedDir = path.join(home, ".gswitchtool");
  mkdirSync(installedDir, { recursive: true });
  const endpoint = process.platform === "win32"
    ? path.join("\\\\.\\pipe", `gswitch-plugin-dev-${randomUUID()}`)
    : path.join(home, "installed.sock");
  const installedApp = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        socket.end(`${JSON.stringify({ id: request.id, result: { invoke_mode: true } })}\n`);
      }
    });
  });
  await new Promise((resolve) => installedApp.listen(endpoint, resolve));
  t.after(() => new Promise((resolve) => installedApp.close(resolve)));
  writeFileSync(path.join(installedDir, "invoke-endpoint.json"), JSON.stringify({ endpoint, token: "installed-app-token" }));
  const status = execFileSync(
    process.execPath,
    [path.join(plugin, "scripts", "codex-companion.mjs"), "invoke-status", "--json"],
    { cwd: home, env, encoding: "utf8" }
  );
  assert.equal(JSON.parse(status).message, "GSwitch Claude Tool (Dev) is not running");

  const staleFile = path.join(plugin, "commands", "removed-on-next-build.md");
  writeFileSync(staleFile, "stale");
  run();
  assert.equal(existsSync(staleFile), false);
});
