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
<on|off>[ · Use first: <codex|claude|price>] · Claude 5h: <n% left|unknown>[ ·
LOW: no Claude workers] · Claude workers: <allowed list>`. Use the newest one.
In mixed mode, Use first decides the candidate order in `router plan`.

Mode, review and allowed workers come from GSwitch's Claude Code panel; their
source is `GSwitch setup`. To change them, tell the owner to use that panel.

- `mixed` or `codex` need Invoke Mode. Check it once per session with the
  `gswitch-delegate` skill's status line. If Invoke Mode is off or GSwitch is
  unavailable, say once "Router paused: Invoke Mode is off; working as a normal
  session" and work normally. Never start Claude workers instead.
- `LOW` (30% or less of the 5-hour window left): no new Claude workers. In
  `mixed`, `router plan` leaves Claude workers out, so new work goes to Codex.
  In `claude`, follow "Wrap up" now. Workers already running may finish their
  current step.
- `Claude 5h: unknown`: the threshold cannot apply; say so once in the report.

## 2. Classify and plan

Classify each task yourself, in your head, before any worker starts (no extra
model call):

- kind: `implement`, `debug`, `refactor`, `test`, `docs`, `review`, `research`
  or `architecture`;
- difficulty: `trivial` (one obvious edit), `small` (one function or file, clear
  fix), `moderate` (several functions or files, some reading needed), `hard`
  (cross-module, unclear cause, or design inside the code) or `high-risk`
  (credentials, account switching and failover, concurrency, money and data
  logic, data deletion, release and update code, security, whatever the size);
- how it is verified: a test or build command (`VERIFY:`), review only, or
  nothing objective (docs, analysis).

A product decision or unclear requirement is not a task for a worker: ask the
owner first.

Then run, once per task (again only to change its classification):

`router plan ${CLAUDE_SESSION_ID} "${CLAUDE_PROJECT_DIR}" --task <id> --kind
<kind> --difficulty <difficulty> --title "<short title>" [--codex
"<model>:<efforts>;<model>:<efforts>"]`

In `mixed` and `codex`, add `--codex` copied from `invoke-status`'s allowed
list, for example `--codex "gpt-6.1-sol:low,medium,high;gpt-6-luna:low,medium,high,xhigh,max"`.
Use one task id (`t1`, `t2`, …) for all attempts at the same task.

The plan prints the task's capability floor, its failures so far, the recovery
for the last failure, and the candidates: workers your settings allow (Claude
workers from the GSwitch Claude Code panel, Codex from Invoke Mode, families by
mode, no Claude workers when LOW) whose agent-benchmark score meets the floor,
ordered by Use first in mixed mode (Codex first by default, Claude first, or
Lowest API price), then cheapest within each family. Single-family modes and
Lowest API price use cheapest first. Floors: trivial and small 0, moderate 42, hard 55, high-risk 60;
`debug` counts as at least moderate and `architecture` as at least hard.

Pick the first candidate unless the task gives a reason for another listed one
(for example a debugging task where a Codex model scores much higher on
terminal work for a few cents more). Never pick a worker that is not listed. The
owner may name a worker for a task; follow it (the hook asks the owner to
confirm a worker below the floor).

The numbers and the method are in `docs/model-benchmarks.md` of the GSwitch
repository.

## 3. Write the brief

The worker sees the repository, not this conversation. The brief states:

- Goal and done-criteria, the constraints that matter, and the files to start
  from.
- What you already know: the cause, files and functions (`file:line`), and the
  commands to run, so the worker does not search for them again.
- `TASK: <id>` and `SCOPE: <glob,glob>`, each on its own line (both required).
  Write the scope generously: the task's files plus their tests and type files.
- `VERIFY: <command>` when a test command exists.
- After a failure: what the earlier attempts changed, the verify output or
  review finding, and why they failed, in a few lines. Name the approach that
  failed so the next worker does not repeat it.

Claude worker: Agent tool, `subagent_type: "router:<model>-<effort>"`, the brief
as prompt, no `model`. Codex: the `gswitch-delegate` skill, with `--write`,
`--scope` and `--verify`, at the chosen model and effort, with the `TASK:` line
in the brief.

Hooks enforce the plan for both Claude workers and Codex: a launch without a
planned `TASK:` is denied, as is a task that already passed and a worker that
already failed it (resume that worker or Codex thread for a repair instead).
The hook shows the owner an approval prompt for a worker below the task's
floor, for any attempt after 3 failed ones, and for any worker that costs more
per attempt than Opus medium (Opus high and above, Sonnet xhigh and above, Haiku
max, Sol max). If the owner denies it, stop and ask.

## 4. Check the result

Trust tool facts only; the worker's text is a claim.

- Claude worker: run `router finish ${CLAUDE_SESSION_ID} "${CLAUDE_PROJECT_DIR}"
  --agent <agentId> [--verify <cmd>]`. It runs verify and the git and scope
  check on the worker's worktree. A clean result is applied; a failed verify or
  apply is recorded as a failure for you, and the worktree is kept for a repair.
  After out-of-scope changes it applies nothing: decide them (section 6). If it
  prints `Worktree kept: <dir> — <reason>`, tell the owner the path and reason.
  A locked worktree of a stopped worker is applied and kept; it can be removed
  after the session. Do not delete worktrees kept for other reasons.
  Every worker must have a stop notice after its latest resume before finish
  verifies or applies it; otherwise wait and run `router finish` again after
  its completion notice. If it has stopped and finish still waits, use
  `router apply`. Repeating finish after a successful apply prints
  `Already applied.`; resuming the worker clears that state. Applied changes are
  not recorded as failures even if cleanup fails. (`router check` and
  `router apply` still exist for manual use; `apply --keep-locked` applies a
  locked worktree and skips cleanup.)
- Codex: `invoke` already reports verify, git facts and warnings.
- Review: same rule as the `gswitch-review` skill. Run it after non-trivial
  changes in `mixed` and `codex`; skip it for typos, comments, formatting,
  renames, one-line fixes and text-only files, and say so in the report. In
  `claude`, run it when the Router line says review on and Invoke Mode is on;
  otherwise read the diff of the changed files yourself and say why in the
  report.
- Read diffs only after a warning, a failed verify, or changes in the high-risk
  list, and then only those files.

Decide the outcome from tool facts:

- `pass`: verify passed (or the change is reviewable only and the review is
  clean), scope warnings resolved, apply succeeded.
- `fail`: verify failed, a serious review finding, the worker stopped, or it
  did only part of the task.
- `unverified`: done, but nothing objective can check it (docs, analysis); you
  read the change. Say so in the report.
- `blocked`: cannot go on without an outside fix or an owner decision.

Record every attempt before you report or recover; `router finish` already
recorded verify and apply failures, so do not record those again. The hooks
count these records, and the next worker or Codex launch on a task is refused
until every earlier attempt on it has a result. This data also replaces the
benchmark's success rates over time:

`router result ${CLAUDE_SESSION_ID} "${CLAUDE_PROJECT_DIR}" --task <id> --title
"<short title>" --difficulty <difficulty> --worker <router:<model>-<effort> |
codex:<model>/<effort> | orchestrator> --step <start|escalation|repair|retry>
--outcome <pass|fail|unverified|blocked> [--reason <reason>] [--agent
<agentId>] [--codex-job <job>] [--codex-thread <thread>]`

A `fail` needs a reason (section 5). Record the difficulty you judged at the
start, even if the task turned out harder. When `router finish` says the worker
changed nothing, record `pass` if nothing was needed, otherwise `fail` with the
cause. When GSwitch refused a Codex run before it started (`MODEL_NOT_ALLOWED`,
`INVOKE_MODE_DISABLED` and similar codes), record it as `blocked` with reason
`tool`; it does not count as a failed attempt.

Use `--worker orchestrator` when you made the edit yourself (the "Yourself"
cases or an owner-requested direct edit). Omit `--agent` and `--codex-*`. Never
record a worker that did not run. These records are not counted in worker
success rates.

## 5. Recover from a failure

Find the cause from the evidence (verify output, review finding, the worker's
`STOPPED:` line, `invoke` codes, apply output) and record it as the reason.
After a failure, `router result` (and `router finish`) print the recovery for
that reason and the new candidates, so no separate `router plan` is needed. The
reasons:

| Reason | Means | Recovery |
| --- | --- | --- |
| `verify` | the change fails its tests or build | repair once: resume the same worker or Codex thread with the failing output; then escalate |
| `review` | a serious review finding | repair once with the finding; then escalate |
| `incomplete` | parts of the brief not done or done wrong | repair once with what is missing; then escalate |
| `capability` | `STOPPED: too hard`, no progress, the same wrong fix twice | escalate |
| `context` | `STOPPED: unclear brief`, a needed fact missing | supply the context and retry the same worker; a product decision goes to the owner |
| `tool` | `STOPPED: environment`, a broken verify command, a crash | fix it, then retry the same worker; never escalate for this |
| `scope` | a scope request | decide it (section 6), then resume the same worker |
| `usage` | Codex or Claude usage ran out | Codex: GSwitch fails over by itself; on a pause, follow the Codex skill's pause rule. Claude LOW: see section 1 |
| `worktree` | apply conflict, worktree gone | tell the owner the kept path and reason; retry on a fresh worktree or ask |
| `stopped` | the owner stopped it | ask the owner |

Escalating means the plan's next candidate: each distinct worker that failed
for `verify`, `review`, `incomplete`, `capability` or `other` raises the floor
one difficulty level and above that worker's score, and is not offered again.
A stronger model is not always right: when the failure looks specific to one
model family in `mixed` (misread instructions, tool trouble), a listed worker
of the other family is a good next pick. Effort is part of the worker, so a
higher effort of the same model is escalation too when it is listed.

Bounds:

- Repairs are once per worker per task, and count as attempts. Codex already
  retried a failed verify once inside `invoke`; after `Verify: FAILED after 1
  retry`, escalate instead of repairing.
- After 3 failed attempts on a task, ask the owner before each further attempt:
  say what each attempt tried and why it failed, and what you would try next.
  The launch hook shows the owner a prompt too.
- Stop and ask the owner when the plan lists no candidate, when the task is
  blocked, or when a recovery needs a decision or an outside fix. Do not write
  the code yourself.

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

Only: one-line fixes left after a passing attempt (a typo, an import), and edits
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
