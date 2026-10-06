---
name: gswitch-invoke
description: Delegate coding work to Codex through GSwitch Invoke Mode to save Claude usage. Runs only when the user invokes it.
argument-hint: "[task for Codex, or nothing to delegate suitable work for the rest of this session]"
disable-model-invocation: true
---

<!-- Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->

# Delegate to Codex with GSwitch Invoke Mode

The goal is to spend less Claude usage: let Codex do work that does not need you.
GSwitch, the user's app, decides which Codex models and reasoning efforts you may use
and owns everything about Codex accounts.

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`

## 1. Check what is allowed

Run `invoke-status` once per session and again after any rejection. If it says GSwitch is
unavailable or Invoke Mode is off, do not delegate through `invoke`; do the work yourself. If it
says Invoke Mode is paused, follow [When Codex usage runs out](#when-codex-usage-runs-out).

## 2. Decide what to delegate

Delegation through GSwitch is the user's explicit choice. Task from the user: $ARGUMENTS

If the user named a task, delegate that task. If they named none, delegate suitable work for
the rest of this session. Never call `invoke` on your own outside a request through this skill.

Suitable work is self-contained work you can state in a brief: implementing a specified change,
refactors, writing or fixing tests, debugging a failing test or error, investigating how
code works, reviews, and mechanical multi-file edits.

Keep for yourself: conversation and decisions that need the user, judgment that depends on
context you would have to transfer at length, and edits smaller than their brief.

## 3. Choose a model and effort

Use only a model and effort listed by `invoke-status`, with the exact names shown. Choose a
lighter model or lower effort for bounded, mechanical work and a stronger model or higher
effort for complex debugging, ambiguous problems, or architecture-sensitive changes.

## 4. Invoke

```
invoke --model <model> --effort <effort> [--write] --cwd "<repository or worktree>" "<brief>"
```

- Add `--write` when Codex should edit files; omit it for review or research.
- Codex sees the repository, not this conversation. The brief states the goal, relevant
  paths, constraints, how to check the result (for example which tests to run), and asks
  for a short summary of what changed. Use `--prompt-file <path>` for a long brief.
- Run long tasks, or several tasks at once, with the Bash tool's `run_in_background`; you
  are notified when each finishes. Do not run two tasks that edit the same files in the
  same working tree at the same time.

## 5. Use the result

The output is Codex's answer followed by one `[codex invoke] ...` line naming the thread.
Check the result in proportion to the risk (for example run the tests or look at the diff)
instead of redoing the work. To continue the same work, add `--resume-thread <thread>` with
the same model and effort.

If a Codex account runs out, GSwitch switches to another allowed account and `invoke`
resumes the same thread by itself; the last line then says it resumed after an account
switch. You do nothing. If the user has their own Codex open, GSwitch asks them in its window
to close it and `invoke` waits; if `invoke-status` reports that, remind the user to close
Codex.

If `invoke` returns `MODEL_NOT_ALLOWED` or `REASONING_NOT_ALLOWED`, run `invoke-status` and
choose again. If it returns `INVOKE_MODE_DISABLED` or `GSWITCH_UNAVAILABLE`, stop
delegating. If it returns `NO_ELIGIBLE_ACCOUNT`, `INVOKE_PAUSED`, or `USAGE_LIMIT_EXCEEDED`,
or the output says PAUSE ALL WORK, follow [When Codex usage runs out](#when-codex-usage-runs-out).
Any other code (for example `EXTERNAL_CODEX_RUNNING`) means automatic recovery stopped: tell
the user what the output says and keep the thread for later. Do not retry it yourself.

## When Codex usage runs out

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
