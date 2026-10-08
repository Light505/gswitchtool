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
  "Luna max": [41, .18, 21.4], "Sol low": [57, .50, 8.6], "Sol medium": [61, .70, 10.9], "Sol xhigh": [63, 1.04, 15.5],
};
const ladders = {
  claude: ["Haiku low", "Haiku medium", "Sonnet low", "Sonnet medium", "Sonnet high", "Opus medium*", "Opus high*", "Opus xhigh*", "Sonnet max"],
  mixed: ["Haiku low", "Luna max", "Sol low", "Sol medium", "Sol xhigh", "Opus xhigh*", "Sonnet max"],
  codex: ["Luna max", "Sol low", "Sol medium", "Sol xhigh"],
};
const classes = { trivial: 0.1, small: 0.25, moderate: 0.5, hard: 1 };
const o = 0.3, a = 0.8, slack = 0.10;
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
for (const [mode, L] of Object.entries(ladders)) {
  console.log(`\n== ${mode} (overhead $${o}, correlation ${a}) ==`);
  const s = L.map((n) => W[n][0] / 100), c = L.map((n) => W[n][1] + o), t = L.map((n) => W[n][2]), top = L.length - 1;
  for (const [cls, k] of Object.entries(classes)) {
    const fail = (i, j) => { const fj = k * (1 - s[j]); if (i < 0) return fj; return a * Math.min(1, fj / (k * (1 - s[i]))) + (1 - a) * fj; };
    // DP on cost, track time along the chosen path.
    const V = Array(L.length).fill(0), T = Array(L.length).fill(0), nx = Array(L.length).fill(null);
    for (let i = top - 1; i >= 0; i--) { let b = Infinity; for (let j = i + 1; j <= top; j++) { const v = c[j] + fail(i, j) * V[j]; if (v < b) { b = v; nx[i] = j; T[i] = t[j] + fail(i, j) * T[j]; } } V[i] = b; }
    const opts = L.map((n, j) => ({ n, cost: c[j] + fail(-1, j) * V[j], time: t[j] + fail(-1, j) * T[j] }));
    const min = Math.min(...opts.map((x) => x.cost));
    const pick = opts.filter((x) => x.cost <= min * (1 + slack)).sort((x, y) => x.time - y.time)[0];
    const line = opts.map((x) => `${x.n} $${x.cost.toFixed(2)}/${x.time.toFixed(0)}m`).join(" | ");
    console.log(`${cls.padEnd(9)} PICK ${pick.n} ($${pick.cost.toFixed(2)}, ${pick.time.toFixed(0)}m; cheapest $${min.toFixed(2)})\n          ${line}`);
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
