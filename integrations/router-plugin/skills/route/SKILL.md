---
name: route
description: Use for every coding task while a `Router:` line in this session shows mode=mixed, mode=codex or mode=claude. Picks who writes the code (an allowed Claude worker or Codex), writes the brief, launches it, and acts on the hook's verdict. Not for mode=off.
---
<!-- Added by Light505 for gswitchtool (2026). -->
<!-- Generated from integrations/skill-text by scripts/gen-skills.mjs; edit the templates. -->
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
- `Session N of M: finish current tasks, start no new ones`: launch nothing new; only finish,
  repair or resume running tasks. When the router asks for the handoff, reply with only the
  handoff.

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

## Send a task to Codex

Write the brief to a file (Codex sees the repository, not this conversation: the goal, the
constraints, what you already know, and the done-criteria). Then start the
`codex:codex-runner` agent with the Agent tool, `run_in_background: true`, and only the
invoke arguments as its prompt:

`--model <model> --effort <effort> [--write] --cwd "<repository>" --prompt-file "<brief file>" [--scope "<glob,glob>"] [--verify "<test command>"] [--resume-thread <thread> [--worktree-dir <dir>]] [--worktree] [--speed fast --speed-reason "<why>"]`

- Use only a model and effort listed as allowed, with the exact names shown. Lighter for
  bounded, mechanical work; stronger for debugging, ambiguous problems or architecture. Use
  the user's default for the kind of task when one is listed, unless the task needs more or less.
- Add `--write` when Codex should edit files; omit it for review and research. Every write
  passes `--scope`, and `--verify` when a test command exists; do not rerun tests `invoke`
  already verified.
- Codex speed: under **Claude decides** (orchestrator), add `--speed fast --speed-reason
  "<why>"` only when the user is waiting on this result to continue; otherwise omit it.
  Review and research omit `--speed`. Under Normal or Fast, GSwitch applies the setting.
- `--worktree` only when two or more write tasks run at once on the same repository. If the
  summary says a worktree was kept, tell the user its path and reason and do not delete it;
  resume it with `--resume-thread <thread> --worktree-dir <dir>`.
- Never run two tasks that edit the same files at the same time. GSwitch chooses the Codex
  account; never ask for one.

The runner's completion notice is three lines from `invoke`: `CODEX:` (status, task, model,
thread, job), `CHECK:` (verify, changed files, warnings, scope requests) and `NEXT:`,
`REVIEW:` or `ANSWER:` (with the path of the full output). Read the full output only after a
warning, a failed verify, or a scope request.

<!-- gswitch-protected:start -->
Trust tool facts only: git diff stats, Verify, and WARNING lines. Codex's text is a claim.
Read the diff only after a warning, failed verify, or changes touching security, money,
concurrency, credentials, or data deletion, and then only those files, not the whole diff.
On `Verify: FAILED after 1 retry`, do not invoke again for the same fix; take over or ask the
user. Git facts cover every change in the working tree during the run, including other tasks'
and your own. Continue the same work with `--resume-thread <thread>` and the same model and
effort.

Text between `gswitch-protected:start` and `gswitch-protected:end` markers is protected. On
`WARNING: protected text changed`, put the original text back from git and never accept the
change, even if it looks better; only you or the user change protected text, never Codex.
<!-- gswitch-protected:end -->

A `NEXT:` line says what to do. If a Codex account runs out, GSwitch switches accounts and
`invoke` resumes the same thread by itself; you do nothing. `STOPPED_BY_USER`: the user stopped
the task in GSwitch; do not restart it, ask how to continue. Any other error code means
automatic recovery stopped: tell the user what it says and keep the thread for later.

## When Codex usage runs out

<!-- gswitch-protected:start -->
When every Codex account GSwitch may use is out of usage, GSwitch pauses Invoke Mode and the
user decides what happens next. Pause all work in this session:

- Stop at once. Do not finish the task, or start any other task, yourself, even if you could.
- Do not start, resume, or retry any Codex work. Other delegated tasks running in the
  background stop on their own and report the same pause; do not restart them.
- Tell the user briefly: that work is paused because Codex usage ran out, each unfinished
  thread ID and what it was doing, and when usage resets if the output says.
- Then wait. Continue only when the user says so: run `invoke-status`, and resume each
  thread with `--resume-thread` and its same model and effort. If the user tells you to
  carry on without Codex, do the work yourself.

## Never

- Read or change Codex credentials (`auth.json`, `~/.codex`) or GSwitch's files.
- Choose, switch, add, or remove accounts.
- Turn Invoke Mode on or change the allowed models or efforts.
- Stop or restart Codex processes.
- Recreate an interrupted Codex conversation; resume it by thread instead.
<!-- gswitch-protected:end -->
