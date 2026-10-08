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

Mode, review and allowed workers come from GSwitch's Claude Code panel; their
source is `GSwitch setup`. To change them, tell the owner to use that panel.

- `mixed` or `codex` need Invoke Mode. Check it once per session with the
  `gswitch-delegate` skill's status line. If Invoke Mode is off or GSwitch is
  unavailable, say once "Router paused: Invoke Mode is off; working as a normal
  session" and work normally. Never start Claude workers instead.
- `LOW` (30% or less of the 5-hour window left): no new Claude workers. In
  `mixed`, send new work to Codex and skip Claude rungs. In `claude`, follow
  "Wrap up" now. Workers already running may finish their current step.
- `Claude 5h: unknown`: the threshold cannot apply; say so once in the report.

## 2. Choose the first worker

Judge the task's difficulty and start at that difficulty's default worker.
Move up the mode's ladder only after a failure (section 5); never start higher
"to be safe", except for high-risk work.

| Difficulty | `claude` | `mixed` | `codex` |
| --- | --- | --- | --- |
| Trivial: rename, move, simple wiring, one-file mechanical edit | Haiku low | Haiku low | Luna max |
| Small: a bounded change in one or two files with a clear spec | Haiku low | Haiku low | Luna max |
| Moderate: a normal feature or tests from a spec, a few files | Haiku medium | Haiku low | Luna max |
| Hard: unclear, cross-module, long, or needs design | Sonnet low | Sol low | Sol low |
| High-risk: credentials, account switching and failover, concurrency, money and data logic, data deletion, release and update code, security | Opus medium | Sol xhigh | Sol xhigh |

| Mode | Ladder |
| --- | --- |
| `claude` | Haiku low → Haiku medium → Sonnet low → Sonnet medium → Sonnet high → Opus medium → Opus high (owner approves) → Sonnet max (owner approves) → stop and ask |
| `mixed` | Haiku low → Luna max → Sol low → Sol medium → Sol xhigh → Sonnet max (owner approves) → stop and ask |
| `codex` | Luna max → Sol xhigh → stop and ask (a hard task starts at Sol low, then Sol xhigh) |

Workers: Claude `router:<model>-<effort>`; Codex `gpt-6-luna` max and
`gpt-6.1-sol` low, medium or xhigh through `gswitch-delegate`.

Why these: each default has the lowest expected total cost for its difficulty
(failed attempts and escalations included, about $0.30 of orchestrator and
review overhead per attempt), or is within 10% of it and faster. Cheap first
attempts pay off because a failure costs little: Haiku low is $0.14 against
$14.19 for Sonnet max. The numbers and the method are in `docs/model-benchmarks.md`
of the GSwitch repository. The owner may name a different start for a task;
follow it.

Not on any ladder (a cheaper rung scores as high, or the step adds too little
for its cost): Haiku high/xhigh/max, Sonnet xhigh, Opus low, Opus xhigh, Opus
max, Sol high/max, Luna below max. Use them only when the owner asks.

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
(every Claude worker that costs more per attempt than Opus medium) are the
owner's decision; if denied, stop and ask. Codex has no such prompt: never use
Sol max without the owner's yes.

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

Record every attempt, pass or fail, before you report or escalate. This data
replaces the benchmark's success rates over time, so never skip it:

`router result ${CLAUDE_SESSION_ID} "${CLAUDE_PROJECT_DIR}" --task <id> --title
"<short title>" --difficulty <trivial|small|moderate|hard|high-risk> --worker
<router:<model>-<effort> | codex:<model>/<effort>> --step <start|escalation>
--outcome <pass|fail> [--reason verify|review|scope|stopped|other]
[--agent <agentId>] [--codex-job <job>] [--codex-thread <thread>]`

Use one task id (for example `t1`, `t2`) for all attempts at the same task.
Record the difficulty you judged at the start, even if the task turned out
harder.

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
  worker only if its worktree still exists. If it is gone (Claude Code deletes
  it when the worker's run changed nothing), start a new worker with the wider
  scope and the previous report instead of resuming. Codex: resume the same
  thread with the wider `--scope`.
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
