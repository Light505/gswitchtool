---
name: gswitch-invoke
description: "Use while a `GSwitch setup: Claude + Codex` line is present: send bounded, self-contained coding tasks to Codex, and get a read-only Codex review after non-trivial changes, through GSwitch Invoke Mode. Also runs when the user types /codex:gswitch-invoke. Not in Router setup (the router's route skill covers it) or Claude only setup. Refuses when Invoke Mode is off."
argument-hint: "[task for Codex, or nothing to delegate suitable work for the rest of this session]"
---

<!-- Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->
<!-- Generated from integrations/skill-text by scripts/gen-skills.mjs; edit the templates. -->

# Delegate to Codex with GSwitch Invoke Mode

The goal is to spend less Claude usage: let Codex do work that does not need you.
GSwitch, the user's app, decides which Codex models and reasoning efforts you may use
and owns everything about Codex accounts.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" invoke-status`

## 1. Check what is allowed

Use the status above (run `invoke-status` again only after a rejection). If it says GSwitch
is unavailable or Invoke Mode is off, do not delegate; do the work yourself and do not mention
it again unless the user asks. If it says Invoke Mode is paused, follow
[When Codex usage runs out](#when-codex-usage-runs-out).

## 2. Decide what to delegate

Task from the user: $ARGUMENTS. If the user named a task, delegate that task. Otherwise, while
the `GSwitch setup: Claude + Codex` line is present, delegate suitable work on your own.

Suitable work is self-contained work you can state in a brief: implementing a specified change,
refactors, writing or fixing tests, debugging a failing test or error, investigating how
code works, reviews, and mechanical multi-file edits.

<!-- gswitch-protected:start -->
Keep for yourself: conversation and decisions that need the user, tasks that depend on
conversation context you would have to transfer at length, and edits where the brief would be
about as long as the edit.

Delegating saves Claude usage only when checking the result costs less than doing the work,
and the check is never skipped. Keep both small: few, larger steps; one feature per session
(start a new session for the next feature); and let `--verify`, git facts, and WARNING lines
do the checking instead of rerunning tests or reading whole diffs.

When the work is on GSwitch itself, delegate through the released plugin named `codex`, never
through `codex-dev`: the dev copy and the Dev app are only for trying changes.
<!-- gswitch-protected:end -->

## 3. Review

After you finish a non-trivial code change, yours or Codex's, and before you report back, run
one read-only Codex review: new or changed behaviour, validation, error handling, data or
money logic, concurrency, security or credentials, migrations, or edits across several
functions or files. Skip typos, comments, formatting, renames and one-line fixes. Use the
runner without `--write`, with a brief that says what changed and why, names the files or git
range, and asks for concrete problems (bugs, risky behaviour, missing tests) by severity with
file and line, without editing files. Findings are claims: check each one yourself, fix what
is real, and tell the user about significant ones. Review each change once; do not loop
review and fix.

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
