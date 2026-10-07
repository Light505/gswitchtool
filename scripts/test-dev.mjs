// Added by Light505 for gswitchtool (2026): opens the isolated dev build for
// testing before a release.
//
//   pnpm run test:dev           build GSwitch Claude Tool (Dev) and open it
//   pnpm run test:dev -- --done close only the dev build
//
// The builds have separate accounts and Codex homes and may run together. The
// test build is copied out of the build folder (so the next build can replace
// its file) and started through Explorer, like a Start-menu launch.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// In the home folder, not AppData: when this runs from Claude's desktop app,
// Windows sends its AppData writes to a private copy that Explorer cannot see.
const testDir = join(homedir(), ".gswitchtool-dev-test");
const devDataDir = join(homedir(), ".gswitchtool-dev");
const testExe = join(testDir, "gswitch-dev.exe");
const done = process.argv.includes("--done");

function fail(message) {
  console.error(`test:dev: ${message}`);
  process.exit(1);
}

if (process.platform !== "win32") {
  fail("this helper is for Windows; run pnpm run app:dev instead.");
}

function powershell(command) {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  return result.stdout.trim();
}

/** Asks a running app to close, as its window's close button would, and waits. */
function closeApp(exePath, label) {
  const escaped = exePath.replace(/'/g, "''");
  const outcome = powershell(
    `$p = Get-Process gswitch, gswitch-dev -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${escaped}' }; ` +
      `if (-not $p) { 'not running' } else { foreach ($one in $p) { [void]$one.CloseMainWindow(); ` +
      `if (-not $one.WaitForExit(15000)) { 'still running' } }; 'closed' }`,
  );
  if (outcome.includes("still running")) {
    fail(`${label} did not close. Close it yourself, then run this again.`);
  }
  if (outcome.includes("closed")) console.log(`Closed ${label}.`);
}

function openApp(exePath, label) {
  spawnSync("explorer.exe", [exePath]);
  console.log(`Opened ${label}.`);
}

function devInvokeStatus() {
  const endpointFile = join(devDataDir, "invoke-endpoint.json");
  if (!existsSync(endpointFile)) return Promise.resolve(null);
  let endpoint;
  try {
    endpoint = JSON.parse(readFileSync(endpointFile, "utf8"));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.endpoint);
    let response = "";
    const timeout = setTimeout(() => socket.destroy(new Error("timeout")), 2500);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, token: endpoint.token, method: "status", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const line = response.split("\n", 1)[0];
      if (line) {
        clearTimeout(timeout);
        socket.end();
        try {
          resolve(JSON.parse(line).result ?? null);
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (["ENOENT", "ECONNREFUSED", "ETIMEDOUT", "timeout"].includes(error.code ?? error.message)) {
        resolve(null);
      } else reject(error);
    });
  });
}

if (done) {
  closeApp(testExe, "GSwitch Claude Tool (Dev)");
  process.exit(0);
}

try {
  const status = await devInvokeStatus();
  if ((status?.workers_running ?? 0) > 0) {
    fail(
      `${status.workers_running} delegated Codex task(s) are running in GSwitch. ` +
        "Wait for the Dev tasks to finish (or stop them in the Codex tasks strip), then run this again.",
    );
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

console.log("Building GSwitch Claude Tool (Dev) from this checkout…");
const args = ["tauri", "build", "--no-bundle"];
const pnpm = process.env.npm_execpath;
const build =
  pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs")
    ? spawnSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: "inherit" })
    : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) fail("the build failed; nothing was closed or opened.");

closeApp(testExe, "the previous GSwitch Claude Tool (Dev)");
mkdirSync(testDir, { recursive: true });
copyFileSync(join(root, "src-tauri", "target", "release", "gswitch.exe"), testExe);
openApp(testExe, "GSwitch Claude Tool (Dev)");
console.log("When you are done testing: pnpm run test:dev -- --done");
