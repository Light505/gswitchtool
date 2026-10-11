// Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
import { PAUSE_ALL_WORK, PAUSE_CODES } from "./gswitch.mjs";

const LINE_LIMIT = 400;
const TASK_ID = /^[\w.-]{1,40}$/;

const oneLine = (text, limit) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

/** The router header lines of a brief: TASK, REVIEWS, KIND and DIFFICULTY (first of each). */
export function briefHeaders(brief) {
  const text = String(brief ?? "");
  const header = (name) => {
    const value = text.match(new RegExp(`^${name}:[ \\t]*(\\S+)[ \\t]*\\r?$`, "m"))?.[1] ?? null;
    return value && TASK_ID.test(value) ? value : null;
  };
  const difficulty = text.match(/^DIFFICULTY:[ \t]*(trivial|small|moderate|hard|high-risk)[ \t]*\r?$/m)?.[1] ?? null;
  return { task: header("TASK"), reviews: header("REVIEWS"), kind: header("KIND"), difficulty };
}

/** The last `REVIEW: <none|minor|serious> · findings: <n>` line of a review answer. */
export function parseReviewLine(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^\s*REVIEW:\s*(none|minor|serious)\b(.*)$/i);
    if (!match) continue;
    const count = match[2].match(/findings:?\s*(\d{1,2})\b/i)?.[1];
    return { review: match[1].toLowerCase(), findings: count === undefined ? null : Number(count) };
  }
  return { review: null, findings: null };
}

function nextAction(result) {
  const code = result.code ?? null;
  const message = oneLine(result.message, 250);
  if (PAUSE_CODES.has(code) || String(result.message ?? "").includes(PAUSE_ALL_WORK)) {
    const reset = /Codex usage resets around [^;]+\)/.exec(String(result.message ?? ""))?.[0];
    return `${PAUSE_ALL_WORK}${reset ? ` (${reset})` : ""}`;
  }
  if (code === "MODEL_NOT_ALLOWED" || code === "REASONING_NOT_ALLOWED") return "choose an allowed model from the Router line, then run again.";
  if (code === "INVOKE_MODE_DISABLED" || code === "GSWITCH_UNAVAILABLE" || code === "CODEX_SIGNED_OUT" || code === "CODEX_SANDBOX_FAILED") return `stop delegating and tell the user: ${message}`;
  if (code === "STOPPED_BY_USER") return "do not restart this task; ask the user how to continue.";
  if (result.worktree && !result.worktree.applied && result.worktree.keptAt) {
    return `worktree kept at ${result.worktree.keptAt} (${oneLine(result.worktree.reason, 150)}); resume the thread there with --resume-thread and --worktree-dir, or discard it.`;
  }
  if (result.protected?.changed?.length) return `protected text changed in ${result.protected.changed.slice(0, 3).join(", ")}; restore it from git.`;
  if (code) return `tell the user: ${message || code}`;
  return null;
}

/**
 * The three lines invoke ends with: CODEX (what ran), CHECK (what was
 * verified and changed), and NEXT, REVIEW or ANSWER (what to do or the answer).
 */
export function invokeSummary(result, { task = null, reviews = null, fullFile = null } = {}) {
  const facts = [
    result.code ? `${result.status} (${result.code})` : result.status,
    `task ${reviews ?? task ?? "-"}`,
    `${result.model}/${result.reasoningEffort}${result.write ? " · write" : ""}`,
    `thread ${result.threadId ?? "-"}`,
    `job ${result.jobId ?? "-"}`
  ];
  if (result.failovers) facts.push(`resumed after ${result.failovers} account switch${result.failovers === 1 ? "" : "es"}`);

  const verify = result.verifySkipped ? "skipped"
    : !result.verify ? "none"
    : result.verify.passed ? (result.verify.retries ? "passed after 1 retry" : `passed (${result.verify.durationSeconds}s)`)
    : `FAILED${result.verify.retries ? " after 1 retry" : ""} (exit ${result.verify.exitCode})`;
  const diff = result.diff?.repository ? result.diff : null;
  const paths = (diff ? diff.files.map((file) => file.path) : result.touchedFiles ?? []).slice(0, 3).map((file) => oneLine(file, 80));
  const warnings = result.warnings ?? [];
  const requests = result.scopeRequests ?? [];
  const check = [
    `Verify ${verify}`,
    `${diff ? diff.totalFiles : (result.touchedFiles ?? []).length} files +${diff?.added ?? 0} −${diff?.deleted ?? 0}${paths.length ? `: ${paths.join(", ")}` : ""}`,
    `${warnings.length} warnings${warnings.length ? `: ${oneLine(String(warnings[0]).replace(/^WARNING: /, ""), 120)}` : ""}`,
    `${requests.length} scope requests${requests.length ? `: ${requests.slice(0, 3).map((request) => oneLine(request.path, 80)).join(", ")}` : ""}`
  ];

  const full = fullFile ? ` · full: ${fullFile}` : "";
  const next = nextAction(result);
  let third;
  if (next) third = `NEXT: ${next}`;
  else if (reviews && !result.write) {
    const { review, findings } = parseReviewLine(result.output);
    third = `REVIEW: ${review ?? "-"} · findings ${findings ?? "-"}${full}`;
  } else {
    // Scope requests are already counted on the CHECK line.
    const first = String(result.output ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("SCOPE REQUEST: ")) ?? "-";
    third = `ANSWER: ${oneLine(first, 200)}${full}`;
  }
  return [`CODEX: ${facts.join(" · ")}`, `CHECK: ${check.join(" · ")}`, third].map((line) => oneLine(line, LINE_LIMIT));
}
