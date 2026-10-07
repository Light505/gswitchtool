// Added by Light505 for gswitchtool (2026): opens the dev build for testing
// before a release, then switches back to the installed app.
//
//   pnpm run test:dev           build GSwitch Claude Tool (Dev) and open it
//   pnpm run test:dev -- --done close it and reopen the installed app
//
// The two builds share accounts and only one may run, so the installed app is
// closed first, but never while Claude's delegated Codex tasks run through it.
// The test build is copied out of the build folder (so the next build can
// replace its file) and started through Explorer, like a Start-menu launch.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localAppData = process.env.LOCALAPPDATA;
const installed = join(localAppData, "GSwitch Claude Tool", "gswitch.exe");
// In the home folder, not AppData: when this runs from Claude's desktop app,
// Windows sends its AppData writes to a private copy that Explorer cannot see.
const testDir = join(homedir(), ".gswitchtool-dev-test");
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

if (done) {
  closeApp(testExe, "GSwitch Claude Tool (Dev)");
  if (existsSync(installed)) openApp(installed, "GSwitch Claude Tool");
  process.exit(0);
}

// Never stop Codex work Claude delegated through the installed app.
try {
  const { readInvokeStatus } = await import(
    "../integrations/codex-plugin-cc/plugins/codex/scripts/lib/gswitch.mjs"
  );
  const status = await readInvokeStatus();
  if ((status.workers_running ?? 0) > 0) {
    fail(
      `${status.workers_running} delegated Codex task(s) are running in GSwitch. ` +
        "Wait for them to finish (or stop them in the Codex tasks strip), then run this again.",
    );
  }
} catch (error) {
  if (error?.code && error.code !== "GSWITCH_UNAVAILABLE") throw error;
  // GSwitch is not running, so nothing can be interrupted.
}

console.log("Building GSwitch Claude Tool (Dev) from this checkout…");
const args = ["tauri", "build", "--no-bundle"];
const pnpm = process.env.npm_execpath;
const build =
  pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs")
    ? spawnSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: "inherit" })
    : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) fail("the build failed; nothing was closed or opened.");

closeApp(installed, "GSwitch Claude Tool");
closeApp(testExe, "the previous GSwitch Claude Tool (Dev)");
mkdirSync(testDir, { recursive: true });
copyFileSync(join(root, "src-tauri", "target", "release", "gswitch.exe"), testExe);
openApp(testExe, "GSwitch Claude Tool (Dev)");
console.log("When you are done testing: pnpm run test:dev -- --done");
