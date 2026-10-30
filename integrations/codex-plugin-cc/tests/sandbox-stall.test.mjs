// Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
import process from "node:process";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { appServerEnv, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { trackActiveCommand, unfinishedCommandWarnings } from "../plugins/codex/scripts/lib/codex.mjs";
import { makeTempDir } from "./helpers.mjs";

test("appServerEnv limits only Windows TEMP and TMP and avoids nested folders", () => {
  const input = { TEMP: "C:\\Users\\user\\AppData\\Local\\Temp", TMP: "other", KEEP: "yes" };
  assert.deepEqual(appServerEnv(input, "win32"), {
    TEMP: "C:\\Users\\user\\AppData\\Local\\Temp\\codex-app-server",
    TMP: "C:\\Users\\user\\AppData\\Local\\Temp\\codex-app-server",
    KEEP: "yes"
  });
  const nested = appServerEnv({ TEMP: "C:\\Temp\\codex-app-server" }, "win32");
  assert.equal(nested.TEMP, "C:\\Temp\\codex-app-server");
  assert.equal(nested.TMP, nested.TEMP);
  assert.equal(appServerEnv(input, "linux"), input);
});

test("close resolves on timeout and rejects pending requests", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const client = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    env: { ...buildEnv(binDir), CODEX_COMPANION_DISABLE_BROKER: "1" },
    closeTimeoutMs: 35
  });
  const actualProc = client.proc;
  client.proc = {
    killed: false,
    exitCode: null,
    stdin: { end() {}, destroy() {} },
    stdout: { destroy() {} },
    stderr: { destroy() {} },
    kill() {},
    unref() {}
  };
  client.sendMessage = () => {};
  const pending = client.request("unanswered", {}).then(() => null, (error) => error);
  const start = Date.now();
  await client.close();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 25 && elapsed < 1000, `close elapsed ${elapsed}ms`);
  assert.match((await pending).message, /closed|exited/i);
  const secondStart = Date.now();
  await client.close();
  assert.ok(Date.now() - secondStart < 100, "second close returns promptly");
  try {
    if (process.platform === "win32") {
      const { terminateProcessTree } = await import("../plugins/codex/scripts/lib/process.mjs");
      terminateProcessTree(actualProc.pid);
    } else actualProc.kill("SIGKILL");
  } catch {}
  actualProc.stdin?.destroy();
  actualProc.stdout?.destroy();
  actualProc.stderr?.destroy();
  actualProc.unref();
});

test("broker close destroys a socket that does not close after EOF", async () => {
  const cwd = makeTempDir();
  const endpoint = createBrokerEndpoint(makeTempDir());
  const target = parseBrokerEndpoint(endpoint);
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.method === "initialize") socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(target.path, resolve));
  try {
    const client = await CodexAppServerClient.connect(cwd, { brokerEndpoint: endpoint, closeTimeoutMs: 35 });
    const pending = client.request("unanswered", {}).then(() => null, (error) => error);
    const start = Date.now();
    await client.close();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 25 && elapsed < 1000, `broker close elapsed ${elapsed}ms`);
    assert.match((await pending).message, /closed|exited/i);
    const secondStart = Date.now();
    await client.close();
    assert.ok(Date.now() - secondStart < 100, "second broker close returns promptly");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unfinished commands get a warning; completed commands get none", () => {
  const warnings = unfinishedCommandWarnings(["slow command --flag"]);
  assert.deepEqual(warnings, ["WARNING: Codex ended its turn while a command was still running (outcome unconfirmed): slow command --flag"]);
  assert.deepEqual(unfinishedCommandWarnings([]), []);
});

test("main-thread command tracking retains unfinished commands and clears completed commands", () => {
  const active = new Map();
  const command = { type: "commandExecution", id: "cmd-1", command: "slow command --flag", status: "inProgress" };
  trackActiveCommand(active, command, "started");
  assert.deepEqual([...active.values()], ["slow command --flag"]);
  trackActiveCommand(active, command, "completed");
  assert.deepEqual([...active.values()], ["slow command --flag"], "inProgress completion remains unfinished");
  trackActiveCommand(active, { ...command, status: "completed" }, "completed");
  assert.deepEqual([...active.values()], []);
  trackActiveCommand(active, command, "started");
  assert.deepEqual(unfinishedCommandWarnings([...active.values()]), ["WARNING: Codex ended its turn while a command was still running (outcome unconfirmed): slow command --flag"]);
});
