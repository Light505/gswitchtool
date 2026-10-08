// Added by Light505 for gswitchtool (2026).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { benchmarks, costPerTask, needsApproval, workerTable } from "../scripts/workers.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(plugin, "scripts/router.mjs");

// Settings (and optional Claude 5h usage) in a temporary HOME; returns a function that runs `router workers ...`.
function fixture(t, router, usedPercentage) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-workers-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, ".gswitchtool");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-setup.json"), JSON.stringify({ version: 1, setup: "router", router: { claudeOnlyReview: "on", ...router } }));
  if (usedPercentage !== undefined) {
    fs.mkdirSync(path.join(home, ".gswitchtool-router"), { recursive: true });
    fs.writeFileSync(path.join(home, ".gswitchtool-router", "usage.json"), JSON.stringify({ fiveHour: { usedPercentage, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  return (...args) => spawnSync(process.execPath, [script, "workers", ...args], { cwd: home, env, encoding: "utf8", windowsHide: true });
}

test("benchmarks keep the Claude costs and Codex values", () => {
  assert.deepEqual(costPerTask, {
    "haiku-low": 0.14, "haiku-medium": 0.23, "haiku-high": 0.36, "haiku-xhigh": 0.61, "haiku-max": 2.58,
    "sonnet-low": 0.48, "sonnet-medium": 0.62, "sonnet-high": 1.24, "sonnet-xhigh": 3.33, "sonnet-max": 14.19,
    "opus-low": 0.63, "opus-medium": 1.45, "opus-high": 2.16, "opus-xhigh": 4.82, "opus-max": 13.04
  });
  assert.equal(needsApproval("opus-medium"), false);
  assert.equal(needsApproval("opus-high"), true);
  assert.deepEqual(benchmarks["opus-medium"], { score: 60, cost: 1.45, minutes: 11, basis: "estimated" });
  assert.deepEqual(benchmarks["codex:gpt-6.1-sol/medium"], { score: 61, cost: 0.7, minutes: 10.9, basis: "measured" });
  assert.deepEqual(benchmarks["codex:gpt-6-luna/high"], { score: null, cost: null, minutes: null, basis: "none" });
});

test("workerTable filters by mode, allowlist, low and namespace", () => {
  const claudeAllowed = { haiku: ["low"], opus: ["medium", "high"] };
  const codexAllowed = { "gpt-6.1-sol": ["low", "high"] };
  const names = (rows) => rows.map((row) => row.worker);
  assert.deepEqual(names(workerTable({ claudeAllowed, codexAllowed, mode: "mixed" })).sort(),
    ["codex:gpt-6.1-sol/high", "codex:gpt-6.1-sol/low", "router:haiku-low", "router:opus-high", "router:opus-medium"].sort());
  assert.deepEqual(names(workerTable({ claudeAllowed, codexAllowed, mode: "codex" })).sort(), ["codex:gpt-6.1-sol/high", "codex:gpt-6.1-sol/low"]);
  assert.deepEqual(names(workerTable({ claudeAllowed, codexAllowed, mode: "claude" })).sort(), ["router:haiku-low", "router:opus-high", "router:opus-medium"]);
  assert.deepEqual(names(workerTable({ claudeAllowed, codexAllowed, mode: "mixed", low: true })), ["codex:gpt-6.1-sol/low", "codex:gpt-6.1-sol/high"]);
  assert.deepEqual(names(workerTable({ claudeAllowed, codexAllowed, mode: "mixed", namespace: "router-dev" })).sort(),
    ["codex-dev:gpt-6.1-sol/high", "codex-dev:gpt-6.1-sol/low", "router-dev:haiku-low", "router-dev:opus-high", "router-dev:opus-medium"].sort());
  assert.equal(workerTable({ claudeAllowed, codexAllowed, mode: "off" }).length, 0);
});

test("workerTable sorts by score, flags approval and estimates", () => {
  const rows = workerTable({ claudeAllowed: { haiku: ["low"], opus: ["medium", "high"] }, codexAllowed: { "gpt-6.1-sol": ["low", "medium", "high"] }, mode: "mixed" });
  assert.deepEqual(rows.map((row) => row.worker), ["router:haiku-low", "codex:gpt-6.1-sol/low", "codex:gpt-6.1-sol/high", "router:opus-medium", "codex:gpt-6.1-sol/medium", "router:opus-high"]);
  assert.equal(rows.find((row) => row.worker === "router:opus-high").approval, true);
  assert.equal(rows.find((row) => row.worker === "router:opus-medium").approval, false);
  assert.equal(rows.find((row) => row.worker === "router:opus-medium").basis, "estimated");
});

test("workerTable dominatedBy picks the cheapest row that is no worse and cheaper", () => {
  const rows = workerTable({ codexAllowed: { "gpt-6.1-sol": ["low", "medium", "high"] }, mode: "codex" });
  const by = Object.fromEntries(rows.map((row) => [row.worker, row.dominatedBy]));
  assert.equal(by["codex:gpt-6.1-sol/high"], "codex:gpt-6.1-sol/medium");
  assert.equal(by["codex:gpt-6.1-sol/medium"], null);
  assert.equal(by["codex:gpt-6.1-sol/low"], null);
  // Sonnet max (68) has no listed row that scores as high or higher, so nothing dominates it.
  const sonnet = workerTable({ claudeAllowed: { haiku: ["low"], sonnet: ["low", "max"] }, mode: "claude" });
  assert.equal(sonnet.find((row) => row.worker === "router:sonnet-max").dominatedBy, null);
});

test("workerTable gives rows without a benchmark basis none and never lets them dominate", () => {
  const rows = workerTable({ codexAllowed: { "gpt-6-luna": ["low", "max"], "gpt-6.1-sol": ["low"] }, mode: "codex" });
  assert.deepEqual(rows.map((row) => row.worker), ["codex:gpt-6-luna/max", "codex:gpt-6.1-sol/low", "codex:gpt-6-luna/low"]);
  const luna = rows.find((row) => row.worker === "codex:gpt-6-luna/low");
  assert.deepEqual([luna.score, luna.cost, luna.minutes, luna.basis, luna.dominatedBy], [null, null, null, "none", null]);
  assert.equal(rows.find((row) => row.worker === "codex:gpt-6-luna/max").dominatedBy, null);
  assert.equal(rows.find((row) => row.worker === "codex:gpt-6.1-sol/low").dominatedBy, null);
});

test("router workers prints the mixed table with notes", (t) => {
  const run = fixture(t, { mode: "mixed", claudeAllowed: { haiku: ["low"], opus: ["medium", "high"] } });
  const r = run("--codex", "gpt-6.1-sol:low,medium,high");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "Router workers (mode=mixed; allowed by your GSwitch settings; agent benchmark per attempt)");
  assert.match(lines[1], /^Worker\s+Score\s+Cost\/try\s+Min\/try\s+Note$/);
  assert.match(lines.find((line) => line.startsWith("router:haiku-low")), /^router:haiku-low\s+28\s+USD 0\.14\s+11\.6$/);
  assert.match(lines.find((line) => line.startsWith("router:opus-medium")), /^router:opus-medium\s+~60\s+USD 1\.45\s+11\s+estimated; skip: codex:gpt-6\.1-sol\/medium scores as high for less$/);
  assert.match(lines.find((line) => line.startsWith("codex:gpt-6.1-sol/high")), /^codex:gpt-6\.1-sol\/high\s+60\s+USD 0\.89\s+13\.3\s+skip: codex:gpt-6\.1-sol\/medium scores as high for less$/);
  assert.match(lines.find((line) => line.startsWith("router:opus-high")), /^router:opus-high\s+~63\s+USD 2\.16\s+16\s+estimated; needs owner approval$/);
  assert.ok(lines.indexOf(lines.find((line) => line.startsWith("router:haiku-low"))) < lines.indexOf(lines.find((line) => line.startsWith("router:opus-high"))));
  assert.ok(!r.stdout.includes("Codex workers not listed"));
  assert.ok(!r.stdout.includes("LOW"));
});

test("router workers codex mode lists only Codex workers and marks no-benchmark rows", (t) => {
  const run = fixture(t, { mode: "codex", claudeAllowed: { haiku: ["low"] } });
  const r = run("--codex", "gpt-6-luna:high;gpt-6.1-sol:low");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Router workers \(mode=codex;/m);
  assert.doesNotMatch(r.stdout, /router:/);
  assert.match(r.stdout, /^codex:gpt-6-luna\/high\s+-\s+-\s+-\s+no agent benchmark; skip$/m);
  assert.match(r.stdout, /^codex:gpt-6\.1-sol\/low\s+57\s+USD 0\.50\s+8\.6$/m);
});

test("router workers claude mode lists Claude workers only", (t) => {
  const run = fixture(t, { mode: "claude", claudeAllowed: { haiku: ["low"], opus: ["high"] } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^router:opus-high\s+~63\s+USD 2\.16\s+16\s+estimated; needs owner approval$/m);
  assert.doesNotMatch(r.stdout, /codex:/);
  assert.ok(!r.stdout.includes("Codex workers not listed"));
});

test("router workers notes LOW Claude usage and leaves Claude workers out", (t) => {
  const run = fixture(t, { mode: "mixed", claudeAllowed: { haiku: ["low"] } }, 80);
  const r = run("--codex", "gpt-6.1-sol:low");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Claude usage LOW: Claude workers left out."));
  assert.doesNotMatch(r.stdout, /router:/);
  assert.match(r.stdout, /^codex:gpt-6\.1-sol\/low\s+57/m);
});

test("router workers without --codex in mixed mode says Codex is not listed", (t) => {
  const run = fixture(t, { mode: "mixed", claudeAllowed: { haiku: ["low"] } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Codex workers not listed: pass --codex with the allowed models and efforts from invoke-status."));
  assert.match(r.stdout, /^router:haiku-low\s+28/m);
});

test("router workers prints only Router is off when routing is off", (t) => {
  const run = fixture(t, { mode: "off", claudeAllowed: { haiku: ["low"] } });
  const r = run("--codex", "gpt-6.1-sol:low");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Router is off.\n");
});

test("router workers rejects invalid --codex and unknown options", (t) => {
  const run = fixture(t, { mode: "mixed", claudeAllowed: { haiku: ["low"] } });
  for (const [args, message] of [
    [["--codex", "gpt-6.1-sol"], /Invalid --codex/],
    [["--codex", "gpt-6.1-sol:low:high"], /Invalid --codex/],
    [["--codex"], /--codex needs a value/],
    [["--codex", "gpt-6.1-sol:turbo"], /Unknown Codex effort "turbo"/],
    [["--json"], /Unknown router workers option: --json/]
  ]) {
    const r = run(...args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.match(r.stderr, message);
    assert.equal(r.stdout, "");
  }
});
