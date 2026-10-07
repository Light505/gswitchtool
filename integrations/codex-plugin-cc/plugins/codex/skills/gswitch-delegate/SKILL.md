---
name: gswitch-delegate
description: "Use only when a `Router:` line in this session says mode=mixed or mode=codex and the router's rules send a task to Codex. Delegates through GSwitch Invoke Mode with a scope and verify command. Refuses when Invoke Mode is off."
---

<!-- Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" invoke-status`

## 1. Check routing and Invoke Mode

Delegate only when a `Router:` line says mode=mixed or mode=codex and the router's
rules send this task to Codex. If status says Invoke Mode is off or GSwitch is
unavailable, do not delegate; tell the orchestrator that routing is paused and
the session runs as a normal session. If Invoke Mode is paused, follow
[When Codex usage runs out](#when-codex-usage-runs-out).

Every call must pass `--scope`, `--write` for code changes, and `--verify` when a
test command exists.

## 3. Choose a model and effort

Use only a model and effort listed by `invoke-status`, with the exact names shown. Choose a
lighter model or lower effort for bounded, mechanical work and a stronger model or higher
effort for complex debugging, ambiguous problems, or architecture-sensitive changes. If
`invoke-status` lists the user's default for the kind of task (review, research, mechanical,
complex), use it unless the task clearly needs more or less.

## 4. Invoke

```
invoke --model <model> --effort <effort> [--write] [--worktree] [--scope "src/**,tests/**"] [--verify "<test command>"] [--resume-thread <thread> --worktree-dir <dir>] --cwd "<repository>" "<brief>"
```

- Add `--write` when Codex should edit files; omit it for review or research.
- Use `--worktree` only when two or more write tasks run at the same time on the same repository. A single task edits the working tree directly. Untracked files are not included in the worktree snapshot. If output says `Worktree kept`, tell the user its path and reason; do not delete it. Resume it with `--resume-thread <thread> --worktree-dir <dir>`.
- Codex sees the repository, not this conversation. The brief states the goal and constraints.
  Pass `--scope` for expected paths and `--verify` when there is a known test command; do not
  rerun tests that `invoke` already verified. Use `--prompt-file <path>` for a long brief.
- Run long tasks with the Bash tool's `run_in_background`; you are notified when each
  finishes.
- Run several tasks at once only when they are independent and each is substantial enough
  to delegate on its own; otherwise send one task. `invoke-status` shows how many GSwitch
  runs at once; tasks beyond that only wait for a free slot. Never
  run two tasks that edit the same files in the same working tree at the same time.
- GSwitch chooses the Codex account (the user's account order); never ask for one.
- When `invoke` reports `SCOPE REQUEST:` lines, Codex was stopped from editing those files. Decide as the router guide says, then resume the same thread with the wider `--scope`.

## 5. Use the result

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

If a Codex account runs out, GSwitch switches to another allowed account and `invoke`
resumes the same thread by itself; the last line then says it resumed after an account
switch. You do nothing. If the user has their own Codex open, GSwitch asks them in its window
to close it and `invoke` waits; if `invoke-status` reports that, remind the user to close
Codex.

If `invoke` returns `MODEL_NOT_ALLOWED` or `REASONING_NOT_ALLOWED`, run `invoke-status` and
choose again. If it returns `INVOKE_MODE_DISABLED` or `GSWITCH_UNAVAILABLE`, stop
delegating. If it returns `NO_ELIGIBLE_ACCOUNT`, `INVOKE_PAUSED`, or `USAGE_LIMIT_EXCEEDED`,
or the output says PAUSE ALL WORK, follow [When Codex usage runs out](#when-codex-usage-runs-out).
If it returns `STOPPED_BY_USER`, the user stopped that task in GSwitch: do not restart or
retry it; say what it was doing and ask how to continue.
Any other code (for example `EXTERNAL_CODEX_RUNNING`) means automatic recovery stopped: tell
the user what the output says and keep the thread for later. Do not retry it yourself.

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
