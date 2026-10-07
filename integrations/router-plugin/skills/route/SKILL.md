---
name: route
description: Use for every coding task while a `Router:` line in this session shows mode=mixed, mode=codex or mode=claude. Decides who writes the code (an allowed Claude worker or Codex), writes the brief with scope and verify, checks the result, and escalates. Not for mode=off.
---
<!-- Added by Light505 for gswitchtool (2026). -->
Router: `${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs` (below: `router`). Run it with
`node "<path>" <command>`; session `${CLAUDE_SESSION_ID}`, project `${CLAUDE_PROJECT_DIR}`.

You are the orchestrator. You decide; workers and Codex write the code. Do not
write task code yourself while the mode is on, except the small fixes listed under
"Yourself".

## 1. Read the Router line

Each message carries `Router: mode=<m> (<source>) · Codex review in claude mode:
<on|off> · Claude 5h: <n% left|unknown>[ · LOW: no Claude workers] · Claude
workers: <allowed list>`. Use the newest one.

- `mixed` or `codex` need Invoke Mode. Check it once per session with the
  `gswitch-delegate` skill's status line. If Invoke Mode is off or GSwitch is
  unavailable, say once "Router paused: Invoke Mode is off; working as a normal
  session" and work normally. Never start Claude workers instead.
- `LOW` (30% or less of the 5-hour window left): no new Claude workers. In
  `mixed`, send new work to Codex and skip Claude rungs. In `claude`, follow
  "Wrap up" now. Workers already running may finish their current step.
- `Claude 5h: unknown`: the threshold cannot apply; say so once in the report.

## 2. Choose the first worker

Each mode has a ladder of rungs. Along every ladder, each rung both costs more
and scores higher than the one before it, so escalating never pays more for a
weaker worker. Scores are the
Artificial Analysis Coding Agent Index (real agentic coding tasks); cost is the
measured API cost per task, which tracks usage.

| Rung | Worker | Score | Cost/task |
| --- | --- | --- | --- |
| H1 | `router:haiku-low` | 28 | $0.14 |
| L | Codex `gpt-6-luna` max | 41 | $0.18 |
| H2 | `router:haiku-medium` | 34 | $0.23 |
| S1 | `router:sonnet-low` | 42 | $0.48 |
| C1 | Codex `gpt-6.1-sol` low | 57 | $0.50 |
| S2 | `router:sonnet-medium` | 46 | $0.62 |
| C2 | Codex `gpt-6.1-sol` medium | 61 | $0.70 |
| C3 | Codex `gpt-6.1-sol` xhigh | 63 | $1.04 |
| S3 | `router:sonnet-high` | 55 | $1.24 |
| S4 | `router:sonnet-xhigh` | 63 | $3.33 |
| S5 | `router:sonnet-max` (owner approves) | 68 | $14.19 |

| Mode | Ladder |
| --- | --- |
| `mixed` | H1 → L → C1 → C2 → C3 → S5 → stop and ask |
| `codex` | L → C1 → C2 → C3 → stop and ask |
| `claude` | H1 → H2 → S1 → S2 → S3 → S4 → S5 → stop and ask |

Start at the cheapest rung that can do the task; escalation does the rest.

- H1: renames, moves, simple wiring, one-file mechanical edits.
- L: other small bounded work, when a ~20-minute run is fine (Haiku is faster
  when speed matters: H1 or H2).
- C1 (`claude`: S1 or S2): a normal feature or tests from a spec.
- C2 or C3 (`claude`: S3 or S4): hard, unclear, cross-module or long work, and
  anything on the high-risk list (credentials, account switching and failover,
  concurrency, money and data logic, data deletion, release and update code,
  security).

Not on any ladder: Haiku high/xhigh/max, Sol high/max, and every Opus worker.
Each costs more than a rung above that scores higher. Opus is allowed by
default but is on no ladder: use it only when the owner asks for it.

Skip rungs whose worker is not in the `Claude workers:` list, or whose Codex
model or effort `invoke-status` does not allow. Worker type:
`router:<model>-<effort>`. The hook rejects anything else, a `model` override,
and any worker that is not allowed.

## 3. Write the brief

The worker sees the repository, not this conversation. The brief states:

- Goal and done-criteria, the constraints that matter, and the files to start
  from.
- `SCOPE: <glob,glob>` on its own line (required). Write it generously: the
  task's files plus their tests and type files.
- `VERIFY: <command>` when a test command exists.
- For an escalation: what the previous rung tried and why it failed (the
  verify output or review finding), in a few lines.

Claude worker: Agent tool, `subagent_type: "router:<model>-<effort>"`, the brief
as prompt, no `model`. Codex: the `gswitch-delegate` skill, with `--write`,
`--scope` and `--verify`, at the rung's model and effort. Approval prompts
(`sonnet-max`, Opus at high or above) are the owner's decision; if denied, stop
and ask.

## 4. Check the result

Trust tool facts only; the worker's text is a claim.

- Claude worker: its result names the worktree when it changed files. Run
  `router check --cwd <worktree> --scope <globs> [--verify <cmd>]`, then
  `router apply --worktree <worktree> --cwd "${CLAUDE_PROJECT_DIR}"`. If
  apply prints `Worktree kept: <dir> — <reason>`, tell the owner the path and
  reason; do not delete it.
- Codex: `invoke` already reports verify, git facts and warnings.
- Review: run `gswitch-review` in `mixed` and `codex`. In `claude`, run it
  when the Router line says review on and Invoke Mode is on; otherwise read the
  diff of the changed files yourself and say why in the report.
- Read diffs only after a warning, a failed verify, or changes in the high-risk
  list, and then only those files.

Pass: report. Fail (verify failed or a serious review finding): next rung.

## 5. Escalation ladder

On a failed verify or a serious review finding, go to the next rung of the
mode's ladder (section 2). Each rung gets the brief plus what the previous
rung tried and why it failed. Never resend the same failed fix to the same
rung, and never go down or sideways. After the last rung, report what each rung tried
and ask; do not write the code yourself.

## 6. Scope requests

A blocked worker ends with `SCOPE REQUEST: <path> — <why> — <intended change>`
(Codex: in the `invoke` result). Decide:

- Approve yourself when the file is closely tied to the task and low risk (a
  matching test, a type file, the same module). Claude worker:
  `router scope ${CLAUDE_SESSION_ID} <agentId> --add <globs>`, then resume the
  worker. Codex: resume the same thread with the wider `--scope`.
- Ask the owner when the file is on the high-risk list; is config, build, CI or
  release; means deleting files or changing protected text; is outside the
  repository; or makes the scope much wider.
- Deny when it is unrelated; tell the worker to finish without it.

An edit outside the scope that got through (a `WARNING: changed outside
--scope` line) is undone from git unless you or the owner approve it.

## 7. Report

What changed (in user terms), which worker did it (model and effort), every
escalation, every scope request and who decided it, the review result, what
was not tested, and anything kept (worktrees, Codex threads).

## Yourself

Only: one-line fixes left after a passing rung (a typo, an import), and edits
where a brief would be as long as the edit. Never in `codex` mode.

## Wrap up

When `claude` mode reaches LOW, or the owner says stop:

1. Start no new worker. Let running ones finish their step.
2. Write a JSON file in the scratchpad: `{ "tasks": [{ "task", "state",
   "next" }], "worktrees": [{ "path", "reason" }], "codexThreads": [{ "thread",
   "model", "effort", "task" }], "resetsAt": "<from router usage>" }`.
3. `router wrapup save ${CLAUDE_SESSION_ID} "${CLAUDE_PROJECT_DIR}" --file <json>`.
4. Tell the owner, briefly: work is paused because Claude usage is low, what is
   unfinished, when usage resets (`router usage`), and that the next session
   offers to resume, discard, or hand it to Codex. Then wait.

At session start, if a line says unfinished work is saved, run
`router wrapup show "${CLAUDE_PROJECT_DIR}"`, summarize it, and ask the owner:
resume, discard (`router wrapup clear`), or hand it to Codex.
