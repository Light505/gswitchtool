---
name: gswitch-review
description: Use proactively after you finish any non-trivial code change, before reporting back, to get a read-only Codex review through GSwitch Invoke Mode. Non-trivial means new or changed behavior, validation, error handling, data or money logic, concurrency, security, or edits across several functions or files; skip only typos, comments, formatting, renames, and one-line fixes. It works only while the user has Invoke Mode on in GSwitch; otherwise it refuses and you continue without it.
argument-hint: "[what to review, or nothing to review the current changes]"
---

<!-- Added by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->

# Codex review through GSwitch Invoke Mode

You decide when a Codex review is worth it. The user's Invoke Mode switch in GSwitch decides
whether it may happen at all: with Invoke Mode off, GSwitch refuses and Codex never starts.

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`

## 1. Check that Invoke Mode is on

Run `invoke-status`. If GSwitch is unavailable or Invoke Mode is off, skip the review and
carry on; do not mention it again in this session unless the user asks.

## 2. Decide whether to review

Reviewing is the default once you have finished a non-trivial code change and before you
report back: new or changed behavior, input validation, error handling, data or money
calculations, concurrency, security or credential handling, migrations, or edits across
several functions or files. Skip only trivial edits: typos, comments, formatting, renames,
and one-line fixes. Review each change once; do not loop review and fix. If the user asked
for a review ($ARGUMENTS), review that.

## 3. Run a read-only review

Choose a model and effort from `invoke-status`, with the exact names shown; use a stronger
model or higher effort for complex or risky changes. Never add `--write`.

```
invoke --model <model> --effort <effort> --cwd "<repository or worktree>" "<brief>"
```

The brief says what changed and why, names the files or the git range to inspect (for
example the uncommitted changes from `git diff`), and asks Codex to report only concrete
problems (bugs, risky behavior, missing tests) ordered by severity with file and line, in a
short list, without editing files.

## 4. Use the findings

Check each finding yourself before acting on it, fix what is real, and tell the user about
significant findings. If `invoke` returns an error code, tell the user what it says and
continue without the review.

## Never

- Read or change Codex credentials (`auth.json`, `~/.codex`) or GSwitch's files.
- Choose, switch, add, or remove accounts, or change Invoke Mode or the allowed models.
- Stop or restart Codex processes.
- Delegate implementation work here; that needs the user's `/codex:gswitch-invoke`.
