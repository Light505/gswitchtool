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
