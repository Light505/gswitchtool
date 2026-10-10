// Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
// invoke-run / invoke-wait: run invoke as a detached child and wait for it in
// steps shorter than a tool timeout, so a cheap agent can hand back 3 lines.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_WAIT_SECONDS = 540;
const RUNNING_EXIT_CODE = 75;
const KEEP_RUN_FILES_MS = 7 * 24 * 3600 * 1000;
const RUN_ID = /^run-[\w.-]+$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runFile = (jobsDir, runId, suffix) => path.join(jobsDir, `${runId}.${suffix}`);

/** Takes `--wait-seconds n` out of an argument list. */
export function stripWaitSeconds(args) {
  const rest = [];
  let waitSeconds = DEFAULT_WAIT_SECONDS;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--wait-seconds" || token.startsWith("--wait-seconds=")) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : args[++index];
      if (value === undefined || !/^\d+(\.\d+)?$/.test(String(value))) throw new Error("--wait-seconds needs a number of seconds.");
      waitSeconds = Number(value);
    } else rest.push(token);
  }
  return { args: rest, waitSeconds };
}

/** The value of `--name value`, `--name=value` or a short flag in an argument list. */
export function optionValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    for (const name of names) {
      if (token === name) return args[index + 1] ?? null;
      if (name.startsWith("--") && token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

function pruneOldRuns(jobsDir) {
  try {
    for (const name of fs.readdirSync(jobsDir)) {
      if (!/^run-.*\.run\.(json|txt|status\.json)$/.test(name)) continue;
      const file = path.join(jobsDir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > KEEP_RUN_FILES_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // Old run files are only clutter.
  }
}

/** Starts `invoke <args>` as a hidden child that survives this process. */
export function startInvokeRun({ script, args, jobsDir }) {
  fs.mkdirSync(jobsDir, { recursive: true });
  pruneOldRuns(jobsDir);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outputFile = runFile(jobsDir, runId, "run.txt");
  const statusFile = runFile(jobsDir, runId, "run.status.json");
  const fd = fs.openSync(outputFile, "a");
  let child;
  try {
    // The child writes the exit code when invoke ends; stdin is not passed on.
    child = spawn(process.execPath, [script, "invoke-run-child", statusFile, ...args], {
      cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true
    });
  } finally { fs.closeSync(fd); }
  child.unref();
  fs.writeFileSync(runFile(jobsDir, runId, "run.json"), JSON.stringify({
    runId, pid: child.pid ?? null, outputFile, statusFile, startedAt: new Date().toISOString(),
    model: optionValue(args, ["--model", "-m"]), effort: optionValue(args, ["--effort"])
  }));
  return runId;
}

/** The body of the hidden child: runs invoke and records its exit code. */
export function superviseInvoke({ script, statusFile, args }) {
  const write = (exitCode) => {
    const temporary = `${statusFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ exitCode, finishedAt: new Date().toISOString() }));
    fs.renameSync(temporary, statusFile);
  };
  const child = spawn(process.execPath, [script, "invoke", ...args], { env: process.env, stdio: "inherit", windowsHide: true });
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); write(1); });
  child.on("close", (code) => write(code ?? 1));
}

/** Finds a run's meta file in this jobs folder, else in any other workspace's. */
export function findRun(jobsDir, runId) {
  if (!RUN_ID.test(runId ?? "")) return null;
  const candidates = [jobsDir];
  try {
    const stateRoot = path.dirname(path.dirname(jobsDir));
    for (const entry of fs.readdirSync(stateRoot)) candidates.push(path.join(stateRoot, entry, path.basename(jobsDir)));
  } catch {}
  for (const dir of candidates) {
    try { return JSON.parse(fs.readFileSync(runFile(dir, runId, "run.json"), "utf8")); }
    catch {}
  }
  return null;
}

function readExitCode(meta) {
  try { return JSON.parse(fs.readFileSync(meta.statusFile, "utf8")).exitCode ?? 1; }
  catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

const oneLine = (text, limit = 250) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

// invoke's last three lines are its summary; anything else (a thrown error, a
// lost process) gets a summary of the same shape so the caller has one format.
function fallbackSummary(meta, code, reason, next) {
  return [
    `CODEX: failed (${code}) · task - · ${meta.model ?? "-"}/${meta.effort ?? "-"} · thread - · job -`,
    "CHECK: Verify none · 0 files +0 −0 · 0 warnings · 0 scope requests",
    `NEXT: ${next} ${reason}`.trim()
  ].map((line) => line.slice(0, 400));
}

function summaryOf(meta, exitCode, lost) {
  let output = "";
  try { output = fs.readFileSync(meta.outputFile, "utf8"); } catch {}
  if (lost) return fallbackSummary(meta, "RUNNER_LOST", `Output so far: ${meta.outputFile}`, "the Invoke process ended without a result; tell the user and read the run file.");
  try {
    const summary = JSON.parse(output).summary;
    if (Array.isArray(summary) && summary.length === 3) return summary.map(String);
  } catch {}
  const lines = output.trimEnd().split(/\r?\n/);
  const tail = lines.slice(-3);
  if (tail.length === 3 && tail[0].startsWith("CODEX: ") && tail[1].startsWith("CHECK: ")) return tail;
  const message = oneLine([...lines].reverse().find((line) => line.trim()) ?? `invoke exited with ${exitCode}`);
  return fallbackSummary(meta, "INVOKE_ERROR", message, "tell the user:");
}

/** Waits for a run; prints its 3 summary lines or the RUNNING line and sets the exit code. */
export async function waitForRun({ meta, script, waitSeconds }) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    let exitCode = readExitCode(meta);
    let lost = false;
    if (exitCode === null && !alive(meta.pid)) {
      await sleep(200); // the status may land just as the child exits
      exitCode = readExitCode(meta);
      lost = exitCode === null;
    }
    if (exitCode !== null || lost) {
      console.log(summaryOf(meta, exitCode, lost).join("\n"));
      process.exitCode = lost ? 1 : exitCode;
      return;
    }
    if (Date.now() >= deadline) {
      console.log(`RUNNING: ${meta.runId} · next: node "${script}" invoke-wait ${meta.runId}`);
      process.exitCode = RUNNING_EXIT_CODE;
      return;
    }
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

export function unknownRun(runId) {
  process.stderr.write(`No Invoke run named ${oneLine(runId, 80) || "(none)"}.\n`);
  process.exitCode = 2;
}
