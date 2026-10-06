// Added by Light505 for gswitchtool (2026): builds the installed app from main only.
// Usage: pnpm run build:installer
//
// The base Tauri configuration is the dev build (GSwitch Claude Tool (Dev)).
// This script adds src-tauri/tauri.main.conf.json, the installed app's identity,
// and refuses to run anywhere but a clean main branch.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function fail(message) {
  console.error(`build:installer: ${message}`);
  process.exit(1);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  fail(`installers are built only from main, but this checkout is on ${branch ?? "an unknown branch"}. Run: git checkout main && git pull`);
}
if (git("status", "--porcelain") !== "") {
  fail("main has uncommitted changes. Commit or stash them first.");
}
const counts = git("rev-list", "--left-right", "--count", "HEAD...@{upstream}");
if (counts) {
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  if (behind > 0) fail(`main is ${behind} commit(s) behind GitHub. Run: git pull`);
  if (ahead > 0) console.warn(`build:installer: main has ${ahead} commit(s) that are not on GitHub yet.`);
}

console.log(`Building the GSwitch Claude Tool installer from main at ${git("rev-parse", "--short", "HEAD")}.`);
// Reuse the pnpm that ran this script (it may come from Corepack, not PATH).
const args = ["tauri", "build", "--config", "src-tauri/tauri.main.conf.json"];
const pnpm = process.env.npm_execpath;
const build = pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs")
  ? spawnSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: "inherit" })
  : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
process.exit(build.status ?? 1);
