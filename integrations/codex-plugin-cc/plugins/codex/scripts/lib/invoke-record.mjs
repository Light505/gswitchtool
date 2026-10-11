// Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
// Invoke writes its own result into the router's results log, so the
// orchestrator does not have to run `router result` after every Codex task.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gswitchTargetRouterDataDir, readClaudeSetup } from "./gswitch.mjs";
import { parseReviewLine } from "./invoke-summary.mjs";

const USAGE_CODES = new Set(["NO_ELIGIBLE_ACCOUNT", "INVOKE_PAUSED", "USAGE_LIMIT_EXCEEDED"]);

/** The router data folder: the test override, the Dev target file, or the released default. */
export function routerDataDir(env = process.env) {
  if (env.GSWITCH_ROUTER_DATA_DIR && path.isAbsolute(env.GSWITCH_ROUTER_DATA_DIR)) return env.GSWITCH_ROUTER_DATA_DIR;
  return gswitchTargetRouterDataDir() ?? path.join(env.USERPROFILE || env.HOME || os.homedir(), ".gswitchtool-router");
}

/** [outcome, reason] from the facts invoke itself has. */
export function invokeOutcome(result) {
  const code = result.code ?? null;
  if (USAGE_CODES.has(code)) return ["fail", "usage"];
  if (code === "STOPPED_BY_USER") return ["fail", "stopped"];
  if (code === "CODEX_SANDBOX_FAILED") return ["blocked", "tool"];
  if (result.status === "rejected") return ["blocked", "tool"];
  if (result.scopeStopped) return ["fail", "scope"];
  if (result.protected?.changed?.length) return ["fail", "other"];
  if (result.verify && !result.verify.passed) return ["fail", "verify"];
  if (result.worktree && !result.worktree.applied) return ["fail", "worktree"];
  if (result.status !== "completed") return ["fail", "tool"];
  if (result.write && (result.diff?.repository ? !result.diff.files.length : !(result.touchedFiles ?? []).length)) return ["fail", "incomplete"];
  return [result.write && result.verify?.passed ? "pass" : "unverified", null];
}

function projectKey(cwd) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  const root = git.status === 0 && git.stdout.trim() ? git.stdout.trim() : cwd;
  const slashes = root.replace(/\\/g, "/");
  const absolute = process.platform === "win32" ? path.win32.resolve(slashes).replace(/\\/g, "/") : path.resolve(slashes);
  return absolute.replace(/\/+$/, "");
}

function readResults(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch { return []; }
  const records = [];
  for (const line of raw.replace(/^﻿/, "").split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {} // An interrupted or corrupt record is skipped.
  }
  return records;
}

// One O_APPEND write per record, like the router's own appendResult.
function appendResult(file, record) {
  const json = JSON.stringify(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a+", 0o600);
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(1);
    const needsNewline = size > 0 && fs.readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10;
    const line = Buffer.from(`${needsNewline ? "\n" : ""}${json}\n`, "utf8");
    if (fs.writeSync(fd, line) !== line.length) throw new Error("Incomplete results log write");
  } finally { fs.closeSync(fd); }
}

// The router's lock: a directory, stale after 60 s; after 10 s we append anyway.
function withRouterLock(dir, action) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "state.lock");
  const started = Date.now();
  let held = false;
  for (;;) {
    try { fs.mkdirSync(lock); held = true; break; }
    catch (error) {
      if (error.code !== "EEXIST") break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmdirSync(lock); } catch {}
      if (Date.now() - started > 10000) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); }
  finally { if (held) try { fs.rmdirSync(lock); } catch {} }
}

/**
 * Records a finished invoke in the router's results log. Only for the router
 * setup, a Claude Code session, and a brief with TASK or REVIEWS. Never throws.
 */
export function recordInvoke({ result, headers, resume = false, cwd, pluginName = "codex" }, env = process.env) {
  try {
    const setup = readClaudeSetup(env);
    if (setup?.setup !== "router" || !["mixed", "codex", "claude"].includes(setup.router.mode)) return;
    const sessionId = String(env.CLAUDE_CODE_SESSION_ID ?? "").trim();
    const id = headers.reviews ?? headers.task;
    if (!sessionId || !id) return;
    const worker = `${pluginName === "codex-dev" ? "codex-dev" : "codex"}:${result.model}/${result.reasoningEffort}`;
    const dir = routerDataDir(env);
    const file = path.join(dir, "results.jsonl");
    const base = { time: new Date().toISOString(), sessionId, project: projectKey(cwd) };
    withRouterLock(dir, () => {
      if (headers.reviews) {
        if (result.write || result.status !== "completed") return;
        const { review, findings } = parseReviewLine(result.output);
        appendResult(file, { type: "review", ...base, task: id, reviewer: worker, review, findings, codexJobId: result.jobId ?? null, codexThreadId: result.threadId ?? null });
        return;
      }
      const records = readResults(file).filter((record) => record.sessionId === sessionId && record.task === id);
      const plan = records.filter((record) => record.type === "plan").at(-1) ?? null;
      const difficulty = headers.difficulty ?? plan?.difficulty ?? null;
      if (!difficulty) return;
      const earlier = records.some((record) => record.type === "result");
      const [outcome, reason] = invokeOutcome(result);
      appendResult(file, {
        type: "result", ...base, task: id, difficulty, worker, outcome, reason,
        step: resume ? "repair" : earlier ? "escalation" : "start", title: plan?.title ?? null, agentId: null,
        codexJobId: result.jobId ?? null, codexThreadId: result.threadId ?? null, review: null, findings: null,
        sample: !earlier && plan?.sample === worker, source: "invoke"
      });
    });
  } catch {
    // Recording must never fail or slow the invoke.
  }
}
