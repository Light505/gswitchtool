---
name: gswitch-invoke
description: Delegate self-contained coding work (implementing a specified change, refactors, tests, debugging, investigation, code review) to Codex through GSwitch Invoke Mode to save Claude usage. Use whenever such work does not need this conversation's judgment and GSwitch reports Invoke Mode is on.
---

<!-- Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->

# Delegate to Codex with GSwitch Invoke Mode

The goal is to spend less Claude usage: let Codex do work that does not need you.
GSwitch, the user's app, decides which Codex models and reasoning efforts you may use
and owns everything about Codex accounts.

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`

## 1. Check what is allowed

Run `invoke-status` once per session and again after any rejection. If it says GSwitch is
unavailable or Invoke Mode is off, do not delegate through `invoke`; do the work yourself.

## 2. Decide what to delegate

Delegate self-contained work you can state in a brief: implementing a specified change,
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

If `invoke` returns `MODEL_NOT_ALLOWED` or `REASONING_NOT_ALLOWED`, run `invoke-status` and
choose again. If it returns `INVOKE_MODE_DISABLED` or `GSWITCH_UNAVAILABLE`, stop
delegating. If it returns `USAGE_LIMIT_EXCEEDED`, tell the user; do not retry it yourself.

## Never

- Read or change Codex credentials (`auth.json`, `~/.codex`) or GSwitch's files.
- Choose, switch, add, or remove accounts.
- Turn Invoke Mode on or change the allowed models or efforts.
- Stop or restart Codex processes.
- Recreate an interrupted Codex conversation; resume it by thread instead.
