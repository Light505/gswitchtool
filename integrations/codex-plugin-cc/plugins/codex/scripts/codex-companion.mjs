#!/usr/bin/env node
// Modified by Light505 for gswitchtool (2026): adds Invoke Mode support. See CREDITS.md in gswitchtool.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { DISABLE_BROKER_ENV } from "./lib/app-server.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { GSwitchError, GSwitchSession, PAUSE_ALL_WORK, pauseInstruction, readInvokeStatus } from "./lib/gswitch.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobsDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh|--resume-thread <thread-id>] [--model <model|spark>] [--effort <effort>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs invoke-status [--json]",
      "  node scripts/codex-companion.mjs invoke --model <model> --effort <effort> [--write] [--worktree] [--worktree-dir <dir>] [--scope <glob[,glob...]>] [--verify <command>] [--resume-thread <thread-id>] [--cwd <dir>] [--json] [prompt]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  // Supported efforts differ per model and Codex version (`model/list`), so the
  // app server decides; only reject values that cannot be an effort name.
  if (!REASONING_EFFORT_PATTERN.test(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use an effort the selected model supports, such as low, medium, high, or xhigh.`
    );
  }
  return normalized;
}

function normalizeResumeThreadId(threadId) {
  if (threadId == null) {
    return null;
  }
  const normalized = String(threadId).trim();
  if (!normalized) {
    throw new Error("--resume-thread requires a Codex thread ID.");
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error("/codex:review maps to the built-in reviewer and does not support custom focus text.");
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This review target is not supported by /codex:review.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast || Boolean(request.resumeThreadId)
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    onAppServer: request.onAppServer,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    // Keep the app-server's structured error code so callers never have to
    // classify failures from message text.
    error: result.error
      ? {
          message: result.error.message ?? null,
          codexErrorInfo: result.error.codexErrorInfo ?? null
        }
      : null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, resumeThreadId = null, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    resumeThreadId,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "resume-thread"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const resumeThreadId = normalizeResumeThreadId(options["resume-thread"]);
  if (resumeThreadId && (resumeLast || fresh)) {
    throw new Error("Choose either --resume-thread or --resume/--resume-last/--fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: resumeLast || Boolean(resumeThreadId)
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast || Boolean(resumeThreadId));

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      resumeThreadId,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        resumeThreadId,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

function renderInvokeStatus(report) {
  if (!report.available) {
    return `${report.message}\n`;
  }
  if (!report.invoke_mode) {
    return "Invoke Mode is off in GSwitch. Do not delegate through invoke; only the user can turn it on.\n";
  }
  if (report.paused) {
    return `Invoke Mode is paused: no Codex account GSwitch may use has usage left. ${pauseInstruction(report.paused.resumes_at)}\n`;
  }
  const profiles = report.allowed_invocation_profiles ?? [];
  const lines = ["Invoke Mode is on. Allowed Codex models and reasoning efforts:"];
  if (profiles.length === 0) {
    lines.push("- none (ask the user to allow models in GSwitch's Invoke settings)");
  }
  for (const profile of profiles) {
    lines.push(
      `- ${profile.model}: ${profile.reasoning_efforts.join(", ")}${
        profile.exclusive
          ? " (only on some of the user's accounts: GSwitch switches to one when this model is used, after other Codex tasks finish)"
          : ""
      }`
    );
  }
  const defaults = Object.entries(report.task_defaults ?? {});
  if (defaults.length) {
    lines.push("The user's default per kind of task:");
    for (const [kind, choice] of defaults) {
      lines.push(`- ${kind}: ${choice.model} ${choice.effort}`);
    }
  }
  lines.push(`Codex workers running: ${report.workers_running ?? 0}`);
  if (report.max_concurrent_tasks) {
    lines.push(
      `GSwitch runs at most ${report.max_concurrent_tasks} Codex task${report.max_concurrent_tasks === 1 ? "" : "s"} at once; more wait their turn.`
    );
  }
  if (report.waiting_for_codex_to_close) {
    lines.push(
      "An account switch is waiting for the user to close Codex (the app, the CLI, and any IDE extension). Ask the user to close it; delegated work resumes automatically."
    );
  } else if (report.failover_in_progress) {
    lines.push("An account failover is in progress; new invocations wait for it.");
  }
  return `${lines.join("\n")}\n`;
}

async function handleInvokeStatus(argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json"] });
  let report;
  try {
    report = { available: true, ...(await readInvokeStatus()) };
  } catch (error) {
    if (!(error instanceof GSwitchError)) {
      throw error;
    }
    report = { available: false, code: error.code, message: error.message };
  }
  outputCommandResult(report, renderInvokeStatus(report), options.json);
}

const INVOKE_REPLY_FORMAT = [
  "Reply format (end with at most 15 lines):",
  "Changed: one line per file, what changed",
  "Tests: commands run + pass/fail",
  "Open questions: none, or list them"
].join("\n");

const VERIFY_RETRY_PROMPT = (command, output) =>
  `The verification command failed. Fix the cause, do not weaken tests or checks.\n\nVerification command: ${command}\n\nLast output:\n${output}\n\n${INVOKE_REPLY_FORMAT}`;

function appendReplyFormat(prompt) {
  return `${prompt.trimEnd()}\n${INVOKE_REPLY_FORMAT}`;
}

// git's tree with no files, for a repository without commits.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function readUntracked(root) {
  const listed = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = new Map();
  if (listed.status !== 0) return files;
  for (const file of listed.stdout.split("\0").filter(Boolean)) {
    try {
      files.set(file, fs.readFileSync(path.join(root, file), "utf8"));
    } catch {
      files.set(file, "");
    }
  }
  return files;
}

function textLines(text) {
  return text ? text.split(/\r?\n/).filter((line, index, lines) => line.length || index < lines.length - 1) : [];
}

/** Lines in `next` but not `previous` (added), and the reverse (deleted). */
function lineDelta(previous, next) {
  const counts = new Map();
  for (const line of textLines(previous)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of textLines(next)) {
    const left = counts.get(line) ?? 0;
    if (left) counts.set(line, left - 1);
    else added += 1;
  }
  let deleted = 0;
  for (const left of counts.values()) deleted += left;
  return { added, deleted };
}

// Records the working tree as the run starts (uncommitted edits included), so
// the facts afterwards cover only what changed during the run.
function snapshotGit(cwd) {
  const probe = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (probe.status !== 0 || !probe.stdout.trim()) return null;
  const root = probe.stdout.trim();
  const stash = gitWaitingForLock(root, ["stash", "create"]);
  if (stash.status !== 0) return null;
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const base = stash.stdout.trim() || (head.status === 0 ? head.stdout.trim() : EMPTY_TREE);
  return { root, base, untracked: readUntracked(root) };
}

function git(cwd, args, options = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, ...options });
}

function gitOutput(cwd, args) {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  return result.stdout.trim();
}

function resolveGitLayout(cwd) {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  const common = gitOutput(root, ["rev-parse", "--git-common-dir"]);
  return { root, commonDir: path.resolve(root, common) };
}

// Parallel invokes snapshot the same repository; git refuses while another
// git process holds its index lock, so wait for it (up to about 15 s).
function gitWaitingForLock(cwd, args) {
  for (let attempt = 0; ; attempt += 1) {
    const result = git(cwd, args);
    if (result.status === 0 || attempt >= 60 || !/index\.lock/.test(result.stderr ?? "")) return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

function createWorktreeBase(root) {
  const stash = gitWaitingForLock(root, ["stash", "create"]);
  if (stash.status !== 0) throw new Error((stash.stderr || "git stash create failed").trim());
  return stash.stdout.trim() || gitOutput(root, ["rev-parse", "HEAD"]);
}

function listDirectories(root, maxDepth, name) {
  const found = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.name === name) found.push({ full, relative });
      else visit(full, depth + 1);
    }
  };
  visit(root, 1);
  return found;
}

function findCargoTargetDir(mainRoot) {
  const cargoManifests = [];
  const visit = (directory, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "Cargo.toml" && fs.statSync(path.join(directory, "target"), { throwIfNoEntry: false })?.isDirectory()) {
        cargoManifests.push(full);
      } else if (entry.isDirectory()) visit(full, depth + 1);
    }
  };
  visit(mainRoot, 1);
  return cargoManifests.length === 1 ? path.join(path.dirname(cargoManifests[0]), "target") : null;
}

function linkSharedDependencies(mainRoot, worktree) {
  const links = [];
  for (const candidate of listDirectories(mainRoot, 3, "node_modules")) {
    if (git(mainRoot, ["check-ignore", "-q", "--", candidate.relative]).status !== 0) continue;
    const destination = path.join(worktree, candidate.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(candidate.full, destination, process.platform === "win32" ? "junction" : "dir");
    links.push(destination);
  }
  return { links, cargoTargetDir: findCargoTargetDir(mainRoot) };
}

// Removes a worktree only after its dependency links are gone, so removal
// can never follow a link into the user's real dependency folders.
function discardWorktree(mainRoot, state) {
  removeWorktreeLinks(state.links ?? []);
  const remainingLinks = (state.links ?? []).filter((link) => {
    try { return fs.lstatSync(link).isSymbolicLink(); } catch { return false; }
  });
  if (remainingLinks.length) return;
  const removed = git(mainRoot, ["worktree", "remove", "--force", state.worktree]);
  if (removed.status === 0) git(mainRoot, ["worktree", "prune"]);
}

function removeWorktreeLinks(links) {
  for (const link of [...links].reverse()) {
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch {}
  }
}

function findWorktreeDependencyLinks(worktree) {
  const links = [];
  const visit = (directory, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      if (entry.name === "node_modules" && entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) visit(full, depth + 1);
    }
  };
  visit(worktree, 1);
  return links;
}

function validWorktreeDirectory(mainRoot, requested) {
  const layout = resolveGitLayout(mainRoot);
  const expectedRoot = path.resolve(layout.commonDir, "gswitch-worktrees");
  const candidate = path.resolve(requested);
  const relative = path.relative(expectedRoot, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("--worktree-dir must name a worktree under this repository's git common dir/gswitch-worktrees.");
  }
  const registered = gitOutput(mainRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => path.resolve(line.slice(9)));
  if (!registered.some((entry) => entry === candidate) || !fs.existsSync(path.join(candidate, ".git"))) {
    throw new Error("--worktree-dir is not a registered worktree for this repository.");
  }
  const mergeHead = git(candidate, ["rev-parse", "--verify", "MERGE_HEAD"]);
  return {
    ...layout,
    worktree: candidate,
    base: mergeHead.status === 0 ? mergeHead.stdout.trim() : gitOutput(candidate, ["rev-parse", "HEAD"]),
    alreadyMerged: mergeHead.status === 0,
    resumed: true,
    links: findWorktreeDependencyLinks(candidate),
    cargoTargetDir: findCargoTargetDir(layout.root)
  };
}

function createInvokeWorktree(mainRoot, jobId) {
  const layout = resolveGitLayout(mainRoot);
  const base = createWorktreeBase(layout.root);
  const directory = path.join(layout.commonDir, "gswitch-worktrees", jobId);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const add = gitWaitingForLock(layout.root, ["worktree", "add", "--detach", directory, base]);
  if (add.status !== 0) throw new Error((add.stderr || "Could not create the invoke worktree.").trim());
  const shared = linkSharedDependencies(layout.root, directory);
  return { ...layout, worktree: directory, base, resumed: false, ...shared };
}

function runGitApply(root, args, input, base) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gswitch-apply-index-"));
  const indexFile = path.join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const readTree = git(root, ["read-tree", base], { env });
    if (readTree.status !== 0) return readTree;
    return git(root, args, { input, env, maxBuffer: 64 * 1024 * 1024 });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function stagedPatch(worktree, base) {
  const add = git(worktree, ["add", "-A"]);
  if (add.status !== 0) throw new Error((add.stderr || "Could not stage worktree changes for patch capture.").trim());
  const diff = git(worktree, ["diff", "--cached", "--binary", base]);
  if (diff.status !== 0) throw new Error((diff.stderr || "Could not capture worktree patch.").trim());
  return diff.stdout;
}

function changedGitFacts(before) {
  const changed = [];
  // Tracked files: the working tree now against its state when the run started.
  const numstat = git(before.root, ["diff", "--numstat", before.base]);
  if (numstat.status !== 0) return { repository: false, files: [] };
  for (const line of numstat.stdout.split(/\r?\n/).filter(Boolean)) {
    const [addedText, deletedText, ...nameParts] = line.split("\t");
    changed.push({ path: nameParts.join("\t").replace(/\\/g, "/"), added: Number(addedText) || 0, deleted: Number(deletedText) || 0 });
  }
  // Untracked files: new, edited, or removed since the run started.
  const untracked = readUntracked(before.root);
  for (const [file, text] of untracked) {
    const previous = before.untracked.get(file);
    if (previous === text) continue;
    changed.push({ path: file, ...lineDelta(previous ?? "", text) });
  }
  for (const [file, text] of before.untracked) {
    if (untracked.has(file) || changed.some((entry) => entry.path === file)) continue;
    changed.push({ path: file, added: 0, deleted: textLines(text).length });
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  return {
    repository: true,
    files: changed,
    totalFiles: changed.length,
    added: changed.reduce((sum, file) => sum + file.added, 0),
    deleted: changed.reduce((sum, file) => sum + file.deleted, 0)
  };
}

function matchesScope(file, pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(file);
}

function getCodexChangedFiles(answer) {
  const lines = String(answer ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^Changed:\s*/i.test(line));
  if (start < 0) return [];
  const output = [];
  for (let index = start; index < lines.length; index += 1) {
    if (index > start && /^(Tests|Open questions):/i.test(lines[index])) break;
    const line = lines[index].replace(/^Changed:\s*/i, "").trim();
    const match = line.match(/(?:^|`)([^`]+\.[A-Za-z0-9._-]+)(?:`|\s|$)/);
    if (match) output.push(match[1]);
  }
  return output;
}

function extractReplySection(answer) {
  const lines = String(answer ?? "").trimEnd().split(/\r?\n/);
  const start = lines.findIndex((line) => /^Changed:/i.test(line));
  const end = lines.findIndex((line, index) => index >= start && /^Open questions:/i.test(line));
  return start >= 0 && end >= start ? lines.slice(start, end + 1).join("\n") : "";
}

// A short answer is shown whole, so read-only findings are never hidden; a
// long one is cut to its reply section, or its first lines.
function compactInvokeAnswer(answer) {
  const normalized = String(answer ?? "").trimEnd();
  const answerLines = normalized ? normalized.split(/\r?\n/) : [];
  if (answerLines.length <= 40) {
    return { text: normalized, shortened: false };
  }
  const reply = extractReplySection(normalized);
  return { text: reply || answerLines.slice(0, 40).join("\n"), shortened: true };
}

function runVerification(command, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, [], { cwd, shell: true, windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ passed: false, exitCode: 127, output: `${output}${error.message}`, durationSeconds: Math.round((Date.now() - started) / 1000) }));
    child.on("close", (exitCode) => resolve({ passed: exitCode === 0, exitCode: exitCode ?? 1, output, durationSeconds: Math.round((Date.now() - started) / 1000) }));
  });
}

function renderInvokeResult(result) {
  const lines = [];
  const answer = compactInvokeAnswer(result.output);
  if (answer.text) {
    lines.push(answer.text);
    if (answer.shortened && result.answerFile) lines.push(`Full answer: ${result.answerFile}`);
  } else if (result.message) {
    lines.push(result.message);
  }
  lines.push("");
  const facts = [result.code ? `${result.status} (${result.code})` : result.status];
  if (result.threadId) facts.push(`thread ${result.threadId}`);
  if (result.jobId) facts.push(`job ${result.jobId}`);
  facts.push(`${result.model}/${result.reasoningEffort}`);
  if (result.write) facts.push("write");
  if (result.failovers) facts.push(`resumed after ${result.failovers} account switch${result.failovers === 1 ? "" : "es"}`);
  lines.push(`[codex invoke] ${facts.join(" · ")}`);
  if (result.verify) {
    if (result.verify.passed && result.verify.retries) lines.push("Verify: passed after 1 retry");
    else if (result.verify.passed) lines.push(`Verify: passed (${result.verify.command}, ${result.verify.durationSeconds}s)`);
    else lines.push(`Verify: FAILED${result.verify.retries ? " after 1 retry" : ""} (exit ${result.verify.exitCode})`, ...result.verify.output.trimEnd().split(/\r?\n/).slice(-20));
  }
  if (result.warnings?.length) lines.push(...result.warnings);
  if (result.worktree) {
    if (result.worktree.applied) lines.push(`Worktree: applied ${result.worktree.conflictsResolved ? "after resolving conflicts" : "to working tree"}`);
    else if (result.worktree.keptAt) lines.push(`Worktree kept: ${result.worktree.keptAt} (${result.worktree.reason})`);
  }
  if (result.diff?.repository) {
    const files = result.diff.files.slice(0, 20).map((file) => `${file.path} (+${file.added} −${file.deleted})`);
    const shownFiles = files.length ? files.join(", ") : "none";
    lines.push(`Changed files (git): ${shownFiles}${result.diff.files.length > 20 ? `, and ${result.diff.files.length - 20} more` : ""}; ${result.diff.totalFiles} files, +${result.diff.added} −${result.diff.deleted}`);
  } else if (result.diff && !result.diff.repository) {
    lines.push("git: not a repository");
    const files = result.touchedFiles ?? [];
    if (files.length) lines.push(`Changed files: ${files.slice(0, 20).join(", ")}${files.length > 20 ? `, and ${files.length - 20} more` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

// Fixed by GSwitch Invoke Mode: the continuation after an account switch is
// owned by this code, never reworded by the invoking model.
const FAILOVER_RESUME_PROMPT =
  "Authentication changed because the previous Codex account reached its usage limit. Resume this existing thread and continue the task from where it stopped. Inspect the current working-tree state before continuing and do not redo completed work.";
// Bounds one invocation if every replacement account is exhausted in turn.
const MAX_FAILOVERS_PER_INVOKE = 3;
// Set only by acceptance tests; see docs/testing.md in gswitchtool.
const SIMULATE_USAGE_LIMIT_ENV = "GSWITCH_INVOKE_SIMULATE_USAGE_LIMIT";

async function handleInvoke(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "resume-thread", "scope", "verify", "worktree-dir"],
    repeatableOptions: ["scope"],
    booleanOptions: ["json", "write", "worktree"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Invoke uses exact model names from invoke-status; aliases are not mapped.
  const model = String(options.model ?? "").trim();
  const effort = normalizeReasoningEffort(options.effort);
  if (!model || !effort) {
    throw new Error("invoke requires --model and --effort chosen from invoke-status.");
  }
  const resumeThreadId = normalizeResumeThreadId(options["resume-thread"]);
  const brief = readTaskPrompt(cwd, options, positionals);
  // The reply format fits edits; a review or investigation answers in its own shape.
  const prompt = brief && options.write ? appendReplyFormat(brief) : brief;
  if (!prompt && !resumeThreadId) {
    throw new Error("Provide the task for Codex as the prompt, --prompt-file, or piped stdin.");
  }
  const write = Boolean(options.write);
  const useWorktree = Boolean(options.worktree || options["worktree-dir"]);
  const base = { model, reasoningEffort: effort, write };
  const finish = (result) => {
    const payload = options.json && result.answerFile
      ? { ...result, output: compactInvokeAnswer(result.output).text }
      : result;
    outputCommandResult(payload, renderInvokeResult(result), options.json);
    process.exitCode = result.status === "completed" && result.worktree?.reason ? 4 : result.verify && !result.verify.passed ? 3 : result.status === "completed" ? 0 : result.status === "rejected" ? 2 : 1;
  };

  if (useWorktree && !write) {
    finish({ ...base, status: "rejected", code: "WORKTREE_UNAVAILABLE", message: "--worktree requires --write." });
    return;
  }
  let mainRoot = cwd;
  if (useWorktree) {
    try { mainRoot = resolveGitLayout(cwd).root; }
    catch {
      finish({ ...base, status: "rejected", code: "WORKTREE_UNAVAILABLE", message: "--worktree requires a git repository." });
      return;
    }
  }
  if (options["worktree-dir"] && !options["resume-thread"]) {
    finish({ ...base, status: "rejected", code: "WORKTREE_UNAVAILABLE", message: "--worktree-dir requires --resume-thread." });
    return;
  }

  let worktreeState = null;
  let actualCwd = cwd;
  let cargoTargetPrevious;
  let cargoTargetSet = false;
  let invokeInterrupted = false;
  // Ctrl+C still stops invoke; the worktree stays so the thread can resume there.
  const onInvokeInterrupt = () => {
    invokeInterrupted = true;
    if (worktreeState?.worktree) process.stderr.write(`Worktree kept: ${worktreeState.worktree} (interrupted)\n`);
    process.exit(130);
  };
  if (useWorktree) {
    try {
      worktreeState = options["worktree-dir"]
        ? validWorktreeDirectory(mainRoot, options["worktree-dir"])
        : createInvokeWorktree(mainRoot, generateJobId("invoke"));
      actualCwd = worktreeState.worktree;
    } catch (error) {
      finish({ ...base, status: "rejected", code: "WORKTREE_UNAVAILABLE", message: error.message });
      return;
    }
  }

  // GSwitch validates the request and tracks this worker for as long as the
  // connection stays open.
  let session;
  let leaseId;
  try {
    session = await GSwitchSession.open();
    leaseId = (
      await session.request("lease_open", { model, reasoning_effort: effort, write, cwd: useWorktree ? actualCwd : workspaceRoot })
    ).lease_id;
  } catch (error) {
    session?.close();
    // Nothing ran: a worktree made for this call is removed, and one being
    // resumed stays as it was.
    let kept = null;
    if (worktreeState?.resumed) kept = worktreeState.worktree;
    else if (worktreeState) discardWorktree(mainRoot, worktreeState);
    const worktree = kept ? { worktree: { applied: false, conflictsResolved: false, keptAt: kept, reason: "nothing ran" } } : {};
    if (!(error instanceof GSwitchError)) {
      if (!worktreeState) throw error;
      finish({ ...base, status: "failed", code: "GSWITCH_UNAVAILABLE", message: error.message, ...worktree });
      return;
    }
    finish({ ...base, status: "rejected", code: error.code, message: error.message, ...worktree });
    return;
  }

  try {
    // Each Invoke worker owns its app server, so it can be stopped and started
    // again under another account without touching other workers.
    process.env[DISABLE_BROKER_ENV] = "1";
    process.on("SIGINT", onInvokeInterrupt);
    if (worktreeState?.cargoTargetDir) {
      cargoTargetPrevious = process.env.CARGO_TARGET_DIR;
      process.env.CARGO_TARGET_DIR = worktreeState.cargoTargetDir;
      cargoTargetSet = true;
    }
    // The invoking model reads stderr too; Node's warning about the Windows
    // shell launch of Codex would cost it tokens on every run.
    process.noDeprecation = true;
    ensureCodexAvailable(actualCwd);
    const runWorkspaceRoot = resolveWorkspaceRoot(actualCwd);
    const gitBefore = snapshotGit(actualCwd);
    const result = await runInvokeWithFailover({
      base, session, leaseId, cwd: actualCwd, workspaceRoot: runWorkspaceRoot, prompt, resumeThreadId,
      verifyCommand: options.verify ? String(options.verify) : null
    });
    if (result.jobId && result.output) {
      const answerFile = path.join(resolveJobsDir(runWorkspaceRoot), `${result.jobId}.answer.txt`);
      fs.writeFileSync(answerFile, result.output, "utf8");
      result.answerFile = answerFile;
    }
    result.diff = gitBefore ? changedGitFacts(gitBefore) : { repository: false, files: [] };
    result.warnings = [];
    const scopedPatterns = (Array.isArray(options.scope) ? options.scope : options.scope ? [options.scope] : [])
      .flatMap((scope) => String(scope).split(",")).map((scope) => scope.trim()).filter(Boolean);
    if (result.diff.repository) {
      if (scopedPatterns.length) {
        for (const file of result.diff.files) {
          if (!scopedPatterns.some((pattern) => matchesScope(file.path, pattern))) result.warnings.push(`WARNING: changed outside --scope: ${file.path}`);
        }
      }
      for (const file of getCodexChangedFiles(result.output)) {
        if (!result.diff.files.some((changed) => changed.path === file)) result.warnings.push(`WARNING: Codex says changed but git shows unchanged: ${file}`);
      }
      if (write && !result.diff.files.length) result.warnings.push("WARNING: write run changed nothing");
      if (!write && result.diff.files.length) result.warnings.push("WARNING: read-only run changed files");
    }
    if (worktreeState) {
      const statusAllowsApply = result.status === "completed" && (!result.verify || result.verify.passed) && !invokeInterrupted;
      if (!statusAllowsApply) {
        const reason = invokeInterrupted || result.code === "STOPPED_BY_USER" ? "interrupted or stopped" : result.verify?.passed === false ? "verification failed" : "run did not complete";
        result.worktree = { applied: false, conflictsResolved: false, keptAt: worktreeState.worktree, reason };
        result.warnings.push(`WARNING: worktree kept: ${reason}`);
      } else {
        try {
          const patch = stagedPatch(actualCwd, worktreeState.base);
          if (worktreeState.alreadyMerged) {
            const threeWayCheck = runGitApply(mainRoot, ["apply", "--3way", "--check", "-"], patch, worktreeState.base);
            const cleanCheck = threeWayCheck.status === 0 ? threeWayCheck : git(mainRoot, ["apply", "--check", "-"], { input: patch });
            if (cleanCheck.status !== 0) throw new Error((cleanCheck.stderr || "The resumed merge patch does not apply cleanly.").trim());
            const applied = git(mainRoot, ["apply", "-"], { input: patch, maxBuffer: 64 * 1024 * 1024 });
            if (applied.status !== 0) throw new Error((applied.stderr || "The resumed merge patch could not be applied.").trim());
            result.worktree = { applied: true, conflictsResolved: true, keptAt: null, reason: null };
            worktreeState.completed = true;
          } else {
          let check = runGitApply(mainRoot, ["apply", "--3way", "--check", "-"], patch, worktreeState.base);
          let conflictsResolved = false;
          let applyBase = worktreeState.base;
          if (check.status !== 0) {
            const newSnapshot = createWorktreeBase(mainRoot);
            const commit = git(actualCwd, ["-c", "user.name=gswitch", "-c", "user.email=gswitch@localhost", "commit", "-m", "gswitch invoke worktree result"]);
            if (commit.status !== 0) throw new Error((commit.stderr || "Could not prepare worktree conflict merge.").trim());
            const merge = git(actualCwd, ["merge", "--no-commit", "--no-ff", newSnapshot]);
            const unresolved = git(actualCwd, ["diff", "--name-only", "--diff-filter=U"]);
            const files = unresolved.stdout.trim().split(/\r?\n/).filter(Boolean);
            if (merge.status !== 0 && files.length) {
              const conflictPrompt = `The user's tree changed while you worked. Resolve the merge conflicts listed below, keeping both sides' intent. Do not touch other files.\n\nConflicting files:\n${files.map((file) => `- ${file}`).join("\n")}`;
              const resumed = await runInvokeWithFailover({
                base, session, leaseId, cwd: actualCwd, workspaceRoot: runWorkspaceRoot,
                prompt: conflictPrompt, resumeThreadId: result.threadId
              });
              result.failovers += resumed.failovers;
              result.threadId = resumed.threadId ?? result.threadId;
              if (resumed.status !== "completed") throw new Error(resumed.message || "Conflict resolution run failed.");
              const markerFiles = files.filter((file) => {
                try { return /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(fs.readFileSync(path.join(actualCwd, file), "utf8")); }
                catch { return false; }
              });
              if (markerFiles.length) throw new Error(`Unresolved merge conflicts: ${markerFiles.join(", ")}`);
              const resolvedStage = git(actualCwd, ["add", "--", ...files]);
              if (resolvedStage.status !== 0) throw new Error(`Could not stage conflict resolution: ${(resolvedStage.stderr || "git add failed").trim()}`);
              const unresolvedAfterResume = git(actualCwd, ["diff", "--name-only", "--diff-filter=U"]);
              if (unresolvedAfterResume.status !== 0) throw new Error(`Could not inspect resolved conflicts: ${(unresolvedAfterResume.stderr || "git diff failed").trim()}`);
              const stillUnresolved = unresolvedAfterResume.stdout.trim();
              if (stillUnresolved) throw new Error(`Unresolved merge conflicts: ${stillUnresolved.split(/\r?\n/).join(", ")}`);
              conflictsResolved = true;
            } else if (merge.status !== 0) {
              throw new Error((merge.stderr || "Could not merge the updated user tree.").trim());
            }
            applyBase = newSnapshot;
            const mergePatch = git(actualCwd, ["diff", "--cached", "--binary", applyBase]);
            if (mergePatch.status !== 0) throw new Error((mergePatch.stderr || "Could not capture resolved worktree patch.").trim());
            check = runGitApply(mainRoot, ["apply", "--3way", "--check", "-"], mergePatch.stdout, applyBase);
            let applyArgs = ["apply", "--3way", "-"];
            if (check.status !== 0) {
              // The user's real index remains at HEAD while the working tree
              // includes its snapshot. The resolved merge already proved both
              // sides combine; check the resulting patch directly against that
              // working tree, then apply without consulting the stale index.
              const cleanCheck = git(mainRoot, ["apply", "--check", "-"], { input: mergePatch.stdout });
              if (cleanCheck.status !== 0) throw new Error(`Resolved patch check failed: ${(cleanCheck.stderr || check.stderr || "The resolved patch still does not apply cleanly.").trim()}`);
              applyArgs = ["apply", "-"];
            }
            const applied = applyArgs.includes("--3way")
              ? runGitApply(mainRoot, applyArgs, mergePatch.stdout, applyBase)
              : git(mainRoot, applyArgs, { input: mergePatch.stdout, maxBuffer: 64 * 1024 * 1024 });
            if (applied.status !== 0) throw new Error((applied.stderr || "The resolved patch could not be applied.").trim());
          } else {
            const applied = runGitApply(mainRoot, ["apply", "--3way", "-"], patch, worktreeState.base);
            if (applied.status !== 0) throw new Error((applied.stderr || "The worktree patch could not be applied.").trim());
          }
          result.worktree = { applied: true, conflictsResolved, keptAt: null, reason: null };
          worktreeState.completed = true;
          }
        } catch (error) {
          result.worktree = { applied: false, conflictsResolved: false, keptAt: worktreeState.worktree, reason: error.message };
          result.warnings.push(`WARNING: worktree changes were not applied: ${error.message}`);
        }
      }
    }
    // GSwitch keeps the result in its activity history; older versions do not.
    await session
      .request("task_result", { lease_id: leaseId, status: result.status, code: result.code ?? null })
      .catch(() => {});
    finish(result);
  } catch (error) {
    if (!worktreeState) throw error;
    await session
      .request("task_result", { lease_id: leaseId, status: "failed", code: "WORKTREE_RUN_FAILED" })
      .catch(() => {});
    finish({
      ...base,
      status: "failed",
      code: "WORKTREE_RUN_FAILED",
      message: error instanceof Error ? error.message : String(error),
      worktree: { applied: false, conflictsResolved: false, keptAt: worktreeState.worktree, reason: error instanceof Error ? error.message : String(error) },
      warnings: [`WARNING: worktree kept because invoke failed: ${error instanceof Error ? error.message : String(error)}`]
    });
  } finally {
    process.off("SIGINT", onInvokeInterrupt);
    session.close();
    if (worktreeState?.worktree && worktreeState.completed) {
      discardWorktree(mainRoot, worktreeState);
    }
    if (cargoTargetSet) {
      if (cargoTargetPrevious === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = cargoTargetPrevious;
    }
  }
}

/**
 * Runs the delegated task. When Codex reports that the account's usage is
 * exhausted, GSwitch alone switches accounts; this worker then resumes the same
 * thread with the same model, effort, sandbox, and working directory.
 */
async function runInvokeWithFailover({ base, session, leaseId, cwd, workspaceRoot, prompt, resumeThreadId, verifyCommand = null }) {
  const job = buildTaskJob(workspaceRoot, buildTaskRunMetadata({ prompt, resumeLast: Boolean(resumeThreadId) }), base.write);
  const { logFile, progress } = createTrackedProgress(job, { stderr: false });
  let threadId = resumeThreadId;
  let runPrompt = prompt;
  let failovers = 0;
  let verifyRetries = 0;
  let verifyResult = null;
  const touched = new Set();
  const failed = (code, message, detail = null) => ({
    ...base,
    status: "failed",
    code,
    detail,
    message,
    jobId: job.id,
    threadId,
    failovers,
    verify: verifyResult ? { ...verifyResult, command: verifyCommand, retries: verifyRetries } : null,
    output: "",
    touchedFiles: [...touched]
  });

  for (;;) {
    try {
      await session.request("run_begin", { lease_id: leaseId });
    } catch (error) {
      return failed(error.code ?? "GSWITCH_UNAVAILABLE", error.message);
    }

    let execution = null;
    let runError = null;
    try {
      execution = await runTrackedJob(
        job,
        () =>
          executeTaskRun({
            cwd,
            model: base.model,
            effort: base.reasoningEffort,
            prompt: runPrompt,
            write: base.write,
            resumeLast: false,
            resumeThreadId: threadId,
            jobId: job.id,
            onAppServer: (pid) => (pid ? session.request("run_app_server", { lease_id: leaseId, pid }) : undefined),
            onProgress: (event) => {
              progress?.(event);
              const reported = typeof event === "object" ? event?.threadId : null;
              if (reported && reported !== threadId) {
                threadId = reported;
                session.request("run_thread", { lease_id: leaseId, thread_id: reported }).catch(() => {});
              }
            }
          }),
        { logFile }
      );
    } catch (error) {
      runError = error;
    }
    for (const file of execution?.payload.touchedFiles ?? []) {
      touched.add(file);
    }
    threadId = execution?.threadId ?? threadId;

    let outcome = "unchanged";
    try {
      outcome = (await session.request("run_end", { lease_id: leaseId })).outcome ?? "unchanged";
    } catch {
      // Without GSwitch nothing can be switched; report the run as it ended.
    }
    if (outcome === "stopped") {
      return failed("STOPPED_BY_USER", new GSwitchError("STOPPED_BY_USER").message);
    }

    // Acceptance testing only: treat the first finished turn as a usage limit so
    // a real failover can be exercised without exhausting an account.
    const simulatedLimit =
      process.env[SIMULATE_USAGE_LIMIT_ENV] === "1" && failovers === 0 && execution?.exitStatus === 0;
    if (execution?.exitStatus === 0 && !simulatedLimit) {
      if (verifyCommand) {
        verifyResult = await runVerification(verifyCommand, cwd);
        if (!verifyResult.passed && verifyRetries === 0) {
          verifyRetries = 1;
          runPrompt = VERIFY_RETRY_PROMPT(verifyCommand, verifyResult.output.split(/\r?\n/).slice(-60).join("\n"));
          continue;
        }
      }
      return {
        ...base,
        status: "completed",
        code: null,
        message: null,
        jobId: job.id,
        threadId,
        failovers,
        verify: verifyResult ? { ...verifyResult, command: verifyCommand, retries: verifyRetries } : null,
        output: execution.payload.rawOutput,
        touchedFiles: [...touched]
      };
    }

    const limited = simulatedLimit || execution?.payload.error?.codexErrorInfo === "usageLimitExceeded";
    const message = execution?.payload.error?.message ?? runError?.message ?? null;
    if (!limited && outcome === "unchanged") {
      // A resume after an account switch that fails outright did not continue the thread.
      return failed(runError && failovers > 0 ? "SESSION_RESUME_FAILED" : "CODEX_FAILED", message);
    }
    if (failovers >= MAX_FAILOVERS_PER_INVOKE) {
      // Every account it switched to ran out in turn.
      return failed(
        "USAGE_LIMIT_EXCEEDED",
        `Codex ran out of usage on ${failovers + 1} accounts in a row. ${PAUSE_ALL_WORK}`
      );
    }
    try {
      if (limited && outcome === "unchanged") {
        await session.request("limit_reached", { lease_id: leaseId });
      }
      if (outcome !== "account_switched") {
        await session.request("await_failover", { lease_id: leaseId });
      }
    } catch (error) {
      return failed(error.code ?? "GSWITCH_UNAVAILABLE", error.message, error.detail ?? null);
    }

    failovers += 1;
    // Resume the exact thread; a run stopped before its thread existed starts over.
    runPrompt = threadId ? FAILOVER_RESUME_PROMPT : prompt;
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "invoke-status":
      await handleInvokeStatus(argv);
      break;
    case "invoke":
      await handleInvoke(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
