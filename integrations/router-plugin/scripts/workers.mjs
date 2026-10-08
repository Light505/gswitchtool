// Added by Light505 for gswitchtool (2026).
export const models = [
  { short: "haiku", id: "claude-haiku-5-5", display: "Haiku 5.5" },
  { short: "sonnet", id: "claude-sonnet-5-5", display: "Sonnet 5.5" },
  { short: "opus", id: "claude-opus-5-5", display: "Opus 5.5" }
];
export const difficulties = ["trivial", "small", "moderate", "hard", "high-risk"];
export const kinds = ["implement", "debug", "refactor", "test", "docs", "review", "research", "architecture"];
// Minimum agent-benchmark score for a first attempt at this difficulty.
export const difficultyFloor = Object.freeze({ trivial: 0, small: 0, moderate: 42, hard: 55, "high-risk": 60 });
// After this many failed attempts on one task, every further attempt needs the owner's yes.
export const ownerCheckAfter = 3;
export const failureReasons = ["verify", "review", "capability", "incomplete", "context", "tool", "scope", "usage", "worktree", "stopped", "other"];
export const workerFailures = ["verify", "review", "capability", "incomplete", "other"];
export const efforts = ["low", "medium", "high", "xhigh", "max"];
export const workerNames = models.flatMap(({ short }) => efforts.map((effort) => `${short}-${effort}`));
// Agent benchmark per attempt: score, API USD cost and minutes. basis: measured, estimated (Opus) or none (no benchmark).
export const benchmarks = Object.freeze({
  "haiku-low": { score: 28, cost: 0.14, minutes: 11.6, basis: "measured" },
  "haiku-medium": { score: 34, cost: 0.23, minutes: 14, basis: "measured" },
  "haiku-high": { score: 35, cost: 0.36, minutes: 18.4, basis: "measured" },
  "haiku-xhigh": { score: 41, cost: 0.61, minutes: 25.9, basis: "measured" },
  "haiku-max": { score: 36, cost: 2.58, minutes: 90, basis: "measured" },
  "sonnet-low": { score: 42, cost: 0.48, minutes: 6.3, basis: "measured" },
  "sonnet-medium": { score: 46, cost: 0.62, minutes: 8.5, basis: "measured" },
  "sonnet-high": { score: 55, cost: 1.24, minutes: 12.3, basis: "measured" },
  "sonnet-xhigh": { score: 63, cost: 3.33, minutes: 27, basis: "measured" },
  "sonnet-max": { score: 68, cost: 14.19, minutes: 90, basis: "measured" },
  "opus-low": { score: 46, cost: 0.63, minutes: 6, basis: "estimated" },
  "opus-medium": { score: 60, cost: 1.45, minutes: 11, basis: "estimated" },
  "opus-high": { score: 63, cost: 2.16, minutes: 16, basis: "estimated" },
  "opus-xhigh": { score: 65, cost: 4.82, minutes: 30, basis: "estimated" },
  "opus-max": { score: 66, cost: 13.04, minutes: 66, basis: "measured" },
  "codex:gpt-6.1-sol/low": { score: 57, cost: 0.5, minutes: 8.6, basis: "measured" },
  "codex:gpt-6.1-sol/medium": { score: 61, cost: 0.7, minutes: 10.9, basis: "measured" },
  "codex:gpt-6.1-sol/high": { score: 60, cost: 0.89, minutes: 13.3, basis: "measured" },
  "codex:gpt-6.1-sol/xhigh": { score: 63, cost: 1.04, minutes: 15.5, basis: "measured" },
  "codex:gpt-6.1-sol/max": { score: 60, cost: 1.55, minutes: 24.4, basis: "measured" },
  "codex:gpt-6-luna/max": { score: 41, cost: 0.18, minutes: 21.4, basis: "measured" },
  "codex:gpt-6-luna/low": { score: null, cost: null, minutes: null, basis: "none" },
  "codex:gpt-6-luna/medium": { score: null, cost: null, minutes: null, basis: "none" },
  "codex:gpt-6-luna/high": { score: null, cost: null, minutes: null, basis: "none" },
  "codex:gpt-6-luna/xhigh": { score: null, cost: null, minutes: null, basis: "none" },
});
// Measured or estimated API USD per agent-session attempt.
export const costPerTask = Object.freeze(Object.fromEntries(workerNames.map((name) => [name, benchmarks[name].cost])));
export function needsApproval(name) {
  const id = benchmarkId(name) ?? name;
  if (/^codex:/.test(id)) return benchmarks[id]?.cost != null && benchmarks[id].cost > costPerTask["opus-medium"];
  return !Object.hasOwn(costPerTask, name) || costPerTask[name] > costPerTask["opus-medium"];
}
export function benchmarkId(worker) {
  if (typeof worker !== "string") return null;
  const claude = worker.match(/^router(?:-dev)?:([a-z]+-[a-z]+)$/);
  if (claude) return claude[1];
  const codex = worker.match(/^codex(?:-dev)?:([a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-z]+)$/);
  return codex ? `codex:${codex[1]}` : null;
}
export function taskFloor(kind, difficulty, failedScores = [], level = 0) {
  // Debug runs commands; Haiku scores 6–13% on the agent Terminal-Bench.
  const minimum = kind === "debug" ? 2 : kind === "architecture" ? 3 : 0;
  const index = Math.min(4, Math.max(difficulties.indexOf(difficulty), minimum) + level);
  const used = difficulties[index];
  const scores = failedScores.filter((score) => typeof score === "number" && Number.isFinite(score));
  return { floor: Math.max(difficultyFloor[used], scores.length ? Math.max(...scores) + 1 : 0), level: used };
}
export function candidates(rows, { floor, exclude = [] }) {
  const allowed = rows.filter((row) => row.basis !== "none" && row.score !== null && row.score >= floor && !exclude.includes(row.worker));
  return allowed.filter((row) => !allowed.some((other) => other.worker === row.dominatedBy))
    .sort((a, b) => a.cost - b.cost || b.score - a.score || a.minutes - b.minutes);
}
export function defaultAllowed() {
  return {
    haiku: ["low", "medium"],
    sonnet: ["low", "medium", "high", "xhigh", "max"],
    opus: ["low", "medium", "high", "xhigh", "max"]
  };
}
// Rows for `router workers`: allowed workers with their benchmark, best score first (then cheapest).
// codexAllowed maps a Codex model to its efforts. dominatedBy names a listed row that is no worse and cheaper.
export function workerTable({ claudeAllowed = {}, codexAllowed = {}, mode, low = false, namespace = "router" }) {
  const codexPrefix = namespace === "router-dev" ? "codex-dev" : "codex";
  const row = (worker, id, approval) => {
    const bench = benchmarks[id] ?? { score: null, cost: null, minutes: null, basis: "none" };
    return { worker, score: bench.score, cost: bench.cost, minutes: bench.minutes, basis: bench.basis, approval, dominatedBy: null };
  };
  const rows = [];
  if ((mode === "claude" || mode === "mixed") && !low) for (const { short } of models) for (const effort of efforts) {
    if (!claudeAllowed[short]?.includes(effort)) continue;
    const id = `${short}-${effort}`;
    rows.push(row(`${namespace}:${id}`, id, needsApproval(id)));
  }
  if (mode === "codex" || mode === "mixed") for (const [model, list] of Object.entries(codexAllowed)) for (const effort of list) {
    rows.push(row(`${codexPrefix}:${model}/${effort}`, `codex:${model}/${effort}`, false));
  }
  const known = (item) => item.basis !== "none" && item.score !== null;
  for (const item of rows) {
    if (!known(item)) continue;
    const dominators = rows.filter((other) => other !== item && known(other) && other.score >= item.score && other.cost <= item.cost &&
      (other.score > item.score || other.cost < item.cost));
    item.dominatedBy = dominators.sort((a, b) => a.cost - b.cost)[0]?.worker ?? null;
  }
  const nullLast = (a, b) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;
  return rows.sort((a, b) => nullLast(a.score, b.score) || nullLast(a.cost, b.cost));
}
