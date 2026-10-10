---
name: route
description: Use for every coding task while a `Router:` line in this session shows mode=mixed, mode=codex or mode=claude. Picks who writes the code (an allowed Claude worker or Codex), writes the brief, launches it, and acts on the hook's verdict. Not for mode=off.
---
<!-- Added by Light505 for gswitchtool (2026). -->
`router` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs"`; session
`${CLAUDE_SESSION_ID}`, project `"${CLAUDE_PROJECT_DIR}"`.

You decide; workers and Codex write the code. Hooks verify, apply and record every
attempt, so you never record results or re-check a pass yourself.

## 1. The Router line

`Router: mode=… · Use first: … · Claude 5h: … · Claude workers: … · Invoke: … · Codex: … ·
Speed: … · Codex review in claude mode: …`. Use the newest one; settings change only in
GSwitch → Claude Code.

- `mixed` or `codex` with `Invoke: off` or `unknown`: say once "Router paused: Invoke Mode
  is off; working as a normal session" and work normally. `Invoke: paused`: follow "When
  Codex usage runs out".
- `LOW`: no new Claude workers. `mixed` sends new work to Codex; `claude` stops and tells
  the user.

## 2. Classify and pick

- kind: `implement`, `debug`, `refactor`, `test`, `docs`, `review`, `research`,
  `architecture`.
- difficulty: `trivial` (one obvious edit), `small` (one function or file), `moderate`
  (several functions or files), `hard` (cross-module, unclear cause, design) or `high-risk`
  (credentials, account switching and failover, concurrency, money and data logic, data
  deletion, release and update code, security, whatever the size).

A product decision or unclear requirement goes to the user first. Trivial and small: take
the cheapest allowed worker in Use first order. Moderate and harder, or when unsure: `router
plan ${CLAUDE_SESSION_ID} "${CLAUDE_PROJECT_DIR}" --task <id> --kind <kind> --difficulty
<difficulty> --title "<title>" --codex "<model>:<efforts>;<model>:<efforts>"` (Codex list
from the Router line) and take its first candidate unless the task gives a reason for
another listed one. Follow a worker the user names. Hooks deny workers that are not allowed
and ask the user before a worker below the task's floor, after 3 failed attempts, and
above Opus medium's cost. If a launch is denied for a sample attempt, launch the named
worker and say "sample attempt" in the report.

## 3. The brief

The worker sees the repository, not this conversation. Start with these lines:

```
TASK: <id>            same id (t1, t2, …) for every attempt at one task
KIND: <kind>
DIFFICULTY: <difficulty>
SCOPE: <glob,glob>    the task's files plus their tests and type files
VERIFY: <command>     when a test or build command exists
```

Then the goal and done-criteria, the constraints that matter, what you already know
(cause, `file:line`, commands), and after a failure what was tried, the failing output,
and why it failed.

## 4. Launch

- Claude worker: Agent tool, `subagent_type: "router:<model>-<effort>"`, the brief as the
  prompt, `run_in_background: true`, no `model`.
- Codex: as in "Send a task to Codex" below. The brief file starts with the same lines;
  pass SCOPE and VERIFY as `--scope` and `--verify`.
- Independent tasks may run at once; never two that edit the same files.

## 5. The verdict

A Claude worker's report ends with the hook's `ROUTER:` line; Codex's with `CODEX:` and
`CHECK:`. Those are tool facts; the rest of the report is a claim.

- `pass` or `unverified`, applied: done. Read a diff only after a warning or for files on
  the high-risk list.
- `fail`: do what its `Next:` line says. Verify, review or incomplete: repair once by
  resuming the same worker (SendMessage) or Codex thread with the failing output, then
  escalate. Capability: the next candidate. Context: supply it and retry. Tool: fix the
  environment, retry, never escalate. After Codex's `Verify: FAILED after 1 retry`,
  escalate instead of repairing.
- Scope: a `SCOPE REQUEST:` or out-of-scope changes. Approve when the file is closely tied
  to the task and low risk (`router scope ${CLAUDE_SESSION_ID} <agentId> --add <globs>`,
  then the commands the ROUTER line prints, or resume Codex with the wider `--scope`). Ask
  the user for high-risk files, config, build, CI or release, deletions, protected text,
  anything outside the repository, or a much wider scope. Deny when unrelated.
- Kept worktree: tell the user its path and reason; never delete it.

## 6. Review

After a moderate, hard or high-risk task passes, run a read-only Codex review (in `claude`
mode only when review is on and Invoke is on): the runner without `--write`, with a brief
that starts `REVIEWS: <task id>`, names the changed files, asks for concrete problems
(bugs, risky behaviour, missing tests) by severity with file and line, and asks Codex to
end with `REVIEW: <none|minor|serious> · findings: <n>`. Check each finding yourself. A
serious real finding reopens the task: repair it with the same `TASK:`.

## 7. Report

What changed (in user terms), who did it (model and effort), the Codex speed, every
escalation, scope decision and review result, what was not tested, and anything kept
(worktrees, Codex threads).

Yourself: only one-line fixes after a pass and edits shorter than their brief; never in
`codex` mode.

<!-- include: codex-rules.md -->
