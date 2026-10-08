// Added by Light505 for gswitchtool (2026).
// Evaluates the router's ladders and high-risk paths with the numbers in docs/model-benchmarks.md.
// Run: node scripts/router-ladder-calc.mjs
// Optional: --results <results.jsonl> reports observed rates without changing picks.
import { readResults, validResult } from "../integrations/router-plugin/scripts/results.mjs";
// [score, cost $, minutes]; * = Opus estimates. o = overhead per attempt, a = correlation.
const W = {
  "Haiku low": [28, .14, 11.6], "Haiku medium": [34, .23, 14.0], "Sonnet low": [42, .48, 6.3], "Sonnet medium": [46, .62, 8.5],
  "Sonnet high": [55, 1.24, 12.3], "Sonnet max": [68, 14.19, 90],
  "Opus medium*": [60, 1.45, 11], "Opus high*": [63, 2.16, 16], "Opus xhigh*": [65, 4.82, 30],
  "Luna max": [41, .18, 21.4], "Sol low": [57, .50, 8.6], "Sol medium": [61, .70, 10.9], "Sol high": [60, .89, 13.3],
};
// Owner's short ladders: every task starts at the first rung; at most two escalations.
// Mixed LOW (Claude usage at 30% or less) and codex use the Codex ladder.
const ladders = {
  claude: ["Haiku low", "Opus medium*", "Opus high*"],
  mixed: ["Haiku low", "Sol medium", "Opus high*"],
  "mixed LOW": ["Sol low", "Sol medium"],
  codex: ["Sol low", "Sol medium"],
};
// High-risk work starts one rung up.
const highRisk = {
  claude: ["Opus medium*", "Opus high*"],
  mixed: ["Sol medium", "Opus high*"],
  codex: ["Sol medium"],
};
const classes = { trivial: 0.1, small: 0.25, moderate: 0.5, hard: 1 };
const o = 0.3, oT = 3, a = 0.8;

// Expected cost and minutes of a fixed path of ladder rungs.
function evalPath(path, cls) { let cost = 0, time = 0, reach = 1, prev = null;
  for (const n of path) { const s = W[n][0] / 100, fj = classes[cls] * (1 - s);
    cost += reach * (W[n][1] + o); time += reach * (W[n][2] + oT);
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
console.log("\n== Chosen defaults (owner's short ladders: every task starts at the first rung; high-risk one rung up) ==");
for (const [mode, path] of Object.entries(ladders)) {
  for (const cls of Object.keys(classes)) {
    const r = evalPath(path, cls);
    console.log(`${mode.padEnd(10)} ${cls.padEnd(9)} START ${path[0]} ($${r.cost.toFixed(2)}, ${r.time.toFixed(0)}m; unsolved ${(r.unsolved * 100).toFixed(1)}%)`);
  }
}
for (const [mode, path] of Object.entries(highRisk)) {
  for (const cls of ["moderate", "hard"]) {
    const r = evalPath(path, cls);
    console.log(`${mode.padEnd(10)} high-risk ${cls.padEnd(9)} START ${path[0]} ($${r.cost.toFixed(2)}, ${r.time.toFixed(0)}m; unsolved ${(r.unsolved * 100).toFixed(1)}%)`);
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
