// Added by Light505 for gswitchtool (2026).
// Recomputes the router default start per difficulty from docs/model-benchmarks.md.
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
// Search candidates: Sol high is dominated by Sol medium, so it is left out of the search.
const candidates = {
  claude: ["Haiku low", "Haiku medium", "Sonnet low", "Sonnet medium", "Sonnet high", "Opus medium*", "Opus high*", "Opus xhigh*", "Sonnet max"],
  mixed: ["Haiku low", "Haiku medium", "Luna max", "Sonnet low", "Sonnet medium", "Sonnet high", "Sol low", "Sol medium", "Opus medium*", "Opus high*", "Opus xhigh*", "Sonnet max"],
  codex: ["Luna max", "Sol low", "Sol medium"],
};
// Approved ladders (owner): each rung must score higher than the one before.
const ladders = {
  claude: ["Haiku low", "Haiku medium", "Sonnet low", "Sonnet medium", "Sonnet high", "Opus medium*", "Opus high*", "Sonnet max"],
  mixed: ["Haiku low", "Sonnet low", "Sonnet medium", "Sol low", "Sol medium", "Opus high*", "Sonnet max"],
  codex: ["Sol low", "Sol medium"],
};
// Approved start per difficulty (high-risk starts are not in the calculation).
const starts = {
  claude: { trivial: "Haiku low", small: "Haiku low", moderate: "Haiku low", hard: "Sonnet low" },
  mixed: { trivial: "Haiku low", small: "Haiku low", moderate: "Haiku low", hard: "Sol low" },
  codex: { trivial: "Sol low", small: "Sol low", moderate: "Sol medium", hard: "Sol medium" },
};
const classes = { trivial: 0.1, small: 0.25, moderate: 0.5, hard: 1 };
// Objective per task = expected cost + lambda x expected minutes (about $3 per hour of waiting).
const o = 0.3, oT = 3, a = 0.8, lambda = 0.05;

// Expected cost and minutes of a fixed path of ladder rungs.
function evalPath(path, cls) { let cost = 0, time = 0, reach = 1, prev = null;
  for (const n of path) { const s = W[n][0] / 100, fj = classes[cls] * (1 - s);
    cost += reach * (W[n][1] + o); time += reach * (W[n][2] + oT);
    const f = prev === null ? fj : a * Math.min(1, fj / (classes[cls] * (1 - prev))) + (1 - a) * fj;
    reach *= f; prev = s; }
  return { cost, time, unsolved: reach }; }

// DP over candidates sorted by score: a move from rung i to j needs a higher score.
function search(names, cls, weight) {
  const k = classes[cls];
  const s = names.map((n) => W[n][0] / 100), c = names.map((n) => W[n][1] + o), t = names.map((n) => W[n][2] + oT);
  const g = c.map((x, j) => x + weight * t[j]), top = names.length - 1;
  const fail = (i, j) => { const fj = k * (1 - s[j]); if (i < 0) return fj; return a * Math.min(1, fj / (k * (1 - s[i]))) + (1 - a) * fj; };
  const V = Array(names.length).fill(0), nx = Array(names.length).fill(null);
  for (let i = top - 1; i >= 0; i--) { let b = Infinity; for (let j = i + 1; j <= top; j++) { const v = g[j] + fail(i, j) * V[j]; if (v < b) { b = v; nx[i] = j; } } V[i] = b; }
  const opts = names.map((n, j) => ({ n, value: g[j] + fail(-1, j) * V[j], j }));
  return { opts, nx };
}
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
console.log(`\n== Search: min expected cost + $${lambda} per minute (overhead $${o} + ${oT} min per attempt, correlation ${a}) ==`);
for (const [mode, names] of Object.entries(candidates)) {
  const sorted = [...names].sort((x, y) => W[x][0] - W[y][0]);
  for (const cls of Object.keys(classes)) {
    const best = search(sorted, cls, lambda), cheap = search(sorted, cls, 0);
    const start = best.opts.reduce((x, y) => (y.value < x.value ? y : x));
    const cheapStart = cheap.opts.reduce((x, y) => (y.value < x.value ? y : x));
    const path = [start.j]; while (best.nx[path[path.length - 1]] !== null) path.push(best.nx[path[path.length - 1]]);
    const names2 = path.map((j) => sorted[j]), r = evalPath(names2, cls);
    console.log(`${mode.padEnd(7)} ${cls.padEnd(9)} BEST ${start.n} ($${r.cost.toFixed(2)}, ${r.time.toFixed(0)}m; cheapest ${cheapStart.n} $${cheapStart.value.toFixed(2)})\n          PATH ${names2.join(" → ")}`);
  }
}

console.log("\n== Chosen defaults (approved starts and ladders; high-risk not in calculation) ==");
for (const [mode, byClass] of Object.entries(starts)) {
  for (const [cls, start] of Object.entries(byClass)) {
    const path = ladders[mode].slice(ladders[mode].indexOf(start));
    const r = evalPath(path, cls);
    console.log(`${mode.padEnd(7)} ${cls.padEnd(9)} START ${start} ($${r.cost.toFixed(2)}, ${r.time.toFixed(0)}m; unsolved ${(r.unsolved * 100).toFixed(1)}%)`);
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
