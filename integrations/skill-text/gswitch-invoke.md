---
name: gswitch-invoke
description: "Use while a `GSwitch setup: Claude + Codex` line is present: send bounded, self-contained coding tasks to Codex, and get a read-only Codex review after non-trivial changes, through GSwitch Invoke Mode. Also runs when the user types /codex:gswitch-invoke. Not in Router setup (the router's route skill covers it) or Claude only setup. Refuses when Invoke Mode is off."
argument-hint: "[task for Codex, or nothing to delegate suitable work for the rest of this session]"
---

<!-- Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->

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

<!-- include: codex-rules.md -->
