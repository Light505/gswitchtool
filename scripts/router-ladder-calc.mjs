// Added by Light505 for gswitchtool (2026).
// Evaluates the router's policy paths with the numbers in docs/model-benchmarks.md.
// Run: node scripts/router-ladder-calc.mjs
// Optional: --results <results.jsonl> reports observed rates without changing picks.
import { readResults, validResult } from "../integrations/router-plugin/scripts/results.mjs";
import { benchmarks, workerTable, defaultAllowed, candidates, taskFloor, ownerCheckAfter, needsApproval, benchmarkId } from "../integrations/router-plugin/scripts/workers.mjs";
// [score, cost $, minutes] from benchmarks; * = Opus estimates. o = overhead per attempt, a = correlation.
const ids = {
  "Haiku low": "haiku-low", "Haiku medium": "haiku-medium", "Sonnet low": "sonnet-low", "Sonnet medium": "sonnet-medium",
  "Sonnet high": "sonnet-high", "Sonnet max": "sonnet-max",
  "Opus medium*": "opus-medium", "Opus high*": "opus-high", "Opus xhigh*": "opus-xhigh",
  "Luna max": "codex:gpt-6-luna/max", "Sol low": "codex:gpt-6.1-sol/low", "Sol medium": "codex:gpt-6.1-sol/medium", "Sol high": "codex:gpt-6.1-sol/high",
};
const W = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, [benchmarks[id].score, benchmarks[id].cost, benchmarks[id].minutes]]));
// Simulate capability failures until the owner check, or until no candidate remains.
const codexAllowed = {
  "gpt-6.1-sol": ["low", "medium", "high"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
};
function policyPath(mode, difficulty) {
  const rows = workerTable({ claudeAllowed: defaultAllowed(), codexAllowed,
    mode: mode === "mixed LOW" ? "mixed" : mode, low: mode === "mixed LOW" });
  const failed = [];
  for (let attempt = 0; attempt < ownerCheckAfter; attempt++) {
    const { floor } = taskFloor("implement", difficulty, failed.map((row) => row.score), failed.length);
    const next = candidates(rows, { floor, exclude: failed.map((row) => row.worker) })[0];
    if (!next) break;
    failed.push(next);
  }
  return failed;
}
const classes = { trivial: 0.1, small: 0.25, moderate: 0.5, hard: 1 };
const o = 0.3, oT = 3, a = 0.8;

// Expected cost and minutes of a policy path.
function evalPath(path, cls) { let cost = 0, time = 0, reach = 1, prev = null;
  for (const n of path) { const w = benchmarks[benchmarkId(n.worker)], s = w.score / 100, fj = classes[cls] * (1 - s);
    cost += reach * (w.cost + o); time += reach * (w.minutes + oT);
    const f = prev === null ? fj : a * Math.min(1, fj / (classes[cls] * (1 - prev))) + (1 - a) * fj;
    reach *= f; prev = s; }
  return { cost, time, unsolved: reach }; }

let observations = [];
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--results" || !args[1] || args[1].startsWith("--"))) {
    throw new Error("Use --results <path>");
  }
  if (args.length) observations = readResults(args[1]).filter(validResult);
} catch (error) {
  console.error(`Router ladder: ${error.message}`);
  process.exit(1);
}
console.log("\n== Policy paths (capability failures; up to 3 attempts before asking the owner) ==");
for (const mode of ["claude", "mixed", "mixed LOW", "codex"]) {
  for (const [difficulty, factor] of [
    ...Object.keys(classes).map((cls) => [cls, cls]),
    ["high-risk", "moderate"], ["high-risk", "hard"],
  ]) {
    const path = policyPath(mode, difficulty), r = evalPath(path, factor);
    const label = difficulty === "high-risk" ? `high-risk (${factor})` : difficulty;
    const names = path.map(({ worker }) => `${worker}${needsApproval(benchmarkId(worker)) ? " (approval)" : ""}`).join(" \u2192 ");
    console.log(`${mode.padEnd(10)} ${label.padEnd(20)} ${names} | $${r.cost.toFixed(2)} | ${r.time.toFixed(0)}m | unsolved ${(r.unsolved * 100).toFixed(1)}%`);
  }
}
if (process.argv.includes("--results")) {
  console.log("\n== Observed results (report only; picks unchanged) ==");
  const groups = new Map();
  for (const record of observations) {
    const key = JSON.stringify([record.worker, record.difficulty]);
    const group = groups.get(key) || { worker: record.worker, difficulty: record.difficulty, count: 0, passes: 0 };
    group.count++;
    if (record.outcome === "pass") group.passes++;
    groups.set(key, group);
  }
  const names = Object.fromEntries(Object.keys(W).map((name) => {
    const [model, effort] = name.replace("*", "").split(" ");
    const worker = model === "Luna" ? `codex:gpt-6-luna/${effort}` : model === "Sol" ? `codex:gpt-6.1-sol/${effort}` : `router:${model.toLowerCase()}-${effort}`;
    return [worker, name];
  }));
  let reported = 0;
  for (const group of [...groups.values()].sort((x, y) => x.worker.localeCompare(y.worker) || x.difficulty.localeCompare(y.difficulty))) {
    if (group.count < 10) continue;
    const model = W[names[group.worker.replace(/^router-dev:/, "router:")]];
    const k = classes[group.difficulty];
    const assumed = model && k !== undefined ? `${((1 - k * (1 - model[0] / 100)) * 100).toFixed(1)}%` : "n/a (no model assumption)";
    console.log(`${group.worker} ${group.difficulty}: observed ${(group.passes / group.count * 100).toFixed(1)}% (${group.passes}/${group.count}), assumed ${assumed}`);
    reported++;
  }
  if (!reported) console.log("No worker/difficulty has at least 10 result records.");
}
