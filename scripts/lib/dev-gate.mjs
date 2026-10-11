// Added by Light505 for gswitchtool (2026): hook wrapper for the Dev plugins. Hooks run only in a session
// that typed /codex-dev:dev-on or /router-dev:dev-on; other sessions get no output, except that router-dev
// adopts a new session (startup or /clear) whose SessionStart loads a pending handoff.
// Usage: node "<plugin root>/dev-gate.mjs" "<plugin root>/scripts/x.mjs" [args...]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEV_PREFIX = "[Dev] ";
const DEV_LINE = `${DEV_PREFIX}Dev test session: follow the [Dev] lines and use the codex-dev / router-dev skills; ignore GSwitch setup and Router lines without [Dev].`;
const CONTEXT_EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);
const MAX_MARKER_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Claude Code runs the plugin from a versioned cache folder, so the name comes from plugin.json, not the folder.
const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginName = (() => {
  try { return JSON.parse(readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8").replace(/^﻿/, "")).name || path.basename(pluginRoot); }
  catch { return path.basename(pluginRoot); }
})();

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function markerDirectory() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".gswitchtool-dev", "dev-sessions");
}

function sessionMarker(sessionId) {
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return safe ? path.join(markerDirectory(), safe) : "";
}

function isDevOn(input) {
  if (input.hook_event_name !== "UserPromptSubmit" || typeof input.prompt !== "string") return false;
  return /^\/(codex-dev|router-dev):dev-on(\s|$)/.test(input.prompt.trim());
}

function enableSession(marker) {
  const directory = path.dirname(marker);
  mkdirSync(directory, { recursive: true });
  writeFileSync(marker, "");
  const cutoff = Date.now() - MAX_MARKER_AGE_MS;
  for (const name of readdirSync(directory)) {
    try {
      const file = path.join(directory, name);
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // Old markers are only cleanup; a failure must not stop the hook.
    }
  }
}

function markLines(text) {
  return text.split("\n").map((line) => (line.trim() ? `${DEV_PREFIX}${line}` : line)).join("\n");
}

function parseContext(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const context = parsed?.hookSpecificOutput?.additionalContext;
    return typeof context === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function main() {
  const [script, ...args] = process.argv.slice(2);
  const text = readStdin();
  const input = parseObject(text);
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  let enabled = false;
  let marker = "";
  try {
    marker = sessionMarker(input.session_id);
    if (marker) {
      if (isDevOn(input)) enableSession(marker);
      enabled = existsSync(marker);
    }
  } catch {
    enabled = false;
  }
  // /clear starts a new session ID: a pending router-dev handoff must still load, and then the session is a Dev session.
  const adopting = !enabled && !!marker && pluginName === "router-dev" && event === "SessionStart" && ["startup", "clear"].includes(input.source);
  if (!enabled && !adopting) process.exit(0);

  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    input: text,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const stdout = child.stdout || "";
  const parsed = parseContext(stdout);
  if (adopting) {
    if (!parsed?.hookSpecificOutput.additionalContext.includes("Handoff from the previous session")) process.exit(0);
    enableSession(marker);
  }
  if (child.stderr) process.stderr.write(child.stderr);
  let output = stdout;
  if (parsed) {
    parsed.hookSpecificOutput.additionalContext = markLines(parsed.hookSpecificOutput.additionalContext);
    output = JSON.stringify(parsed);
  }
  // Only the router-dev copy adds the session note, so it appears once when both plugins run.
  if (CONTEXT_EVENTS.has(event) && pluginName === "router-dev") {
    if (!stdout.trim() || stdout.trim() === "{}") {
      output = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: DEV_LINE } });
    } else if (parsed) {
      parsed.hookSpecificOutput.additionalContext += `\n${DEV_LINE}`;
      output = JSON.stringify(parsed);
    }
  }
  if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  // Set the exit code instead of process.exit so piped stdout is flushed first.
  // A killed or unstartable hook is an error, never a silent success.
  process.exitCode = child.status ?? 1;
}

try {
  main();
} catch {
  // A gate error must never block a prompt or tool call.
  process.exit(0);
}
