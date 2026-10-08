// Added by Light505 for gswitchtool (2026).

import test from "node:test";
import assert from "node:assert/strict";

import { unmatchedCodexPaths } from "../plugins/codex/scripts/lib/git.mjs";

test("unmatchedCodexPaths accepts paths relative to a subfolder the run started in", () => {
  assert.deepEqual(unmatchedCodexPaths(["src/a.ts"], ["app/src/a.ts"], "app", "/repo"), []);
});

test("unmatchedCodexPaths compares Windows absolute root prefixes case-insensitively", () => {
  assert.deepEqual(unmatchedCodexPaths(["c:\\repo\\src\\a.ts"], ["src/a.ts"], "", "C:\\repo"), []);
});

test("unmatchedCodexPaths does not use the cwd fallback for absolute paths", () => {
  assert.deepEqual(unmatchedCodexPaths(["/repo/src/a.ts"], ["app/src/a.ts"], "app", "/repo"), ["/repo/src/a.ts"]);
});

test("unmatchedCodexPaths resolves parent-relative paths without allowing root escapes", () => {
  assert.deepEqual(unmatchedCodexPaths(["../src/a.ts"], ["src/a.ts"], "app", "/repo"), []);
  assert.deepEqual(unmatchedCodexPaths(["../../src/a.ts"], ["../src/a.ts"], "app", "/repo"), ["../../src/a.ts"]);
});

test("unmatchedCodexPaths expands brace groups into each named file", () => {
  assert.deepEqual(unmatchedCodexPaths(["src/{a,b}.ts"], ["src/a.ts", "src/b.ts"]), []);
});

test("unmatchedCodexPaths normalizes ./, backslashes and absolute paths inside the root", () => {
  const gitPaths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const named = ["./src/a.ts", "src\\b.ts", "/repo/src/c.ts"];
  assert.deepEqual(unmatchedCodexPaths(named, gitPaths, "", "/repo"), []);
});

test("unmatchedCodexPaths accepts a bare file name when exactly one changed path has that base name", () => {
  const gitPaths = ["plugins/codex/scripts/lib/git.mjs", "tests/invoke-changed-paths.test.mjs"];
  assert.deepEqual(unmatchedCodexPaths(["git.mjs", "invoke-changed-paths.test.mjs"], gitPaths, "", "/repo"), []);
});

test("unmatchedCodexPaths still reports a bare file name that is ambiguous or unknown", () => {
  const gitPaths = ["src/index.ts", "lib/index.ts", "src/a.ts"];
  assert.deepEqual(unmatchedCodexPaths(["index.ts", "missing.ts"], gitPaths, "", "/repo"), ["index.ts", "missing.ts"]);
});

test("unmatchedCodexPaths does not match a path with a folder by its base name alone", () => {
  assert.deepEqual(unmatchedCodexPaths(["other/a.ts"], ["src/a.ts"], "", "/repo"), ["other/a.ts"]);
});

test("unmatchedCodexPaths still reports a file git does not show as changed, as Codex wrote it", () => {
  const named = ["src/a.ts", "src/missing.ts", "src/{a,nope}.ts"];
  assert.deepEqual(unmatchedCodexPaths(named, ["src/a.ts"], "", "/repo"), ["src/missing.ts", "src/{a,nope}.ts"]);
});
