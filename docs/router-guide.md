# Router guide

The router is an optional Claude Code plugin (`router@gswitchtool`) that sits on
top of the Codex plugin. The Claude Code session you open is the orchestrator.
The router decides, for each coding task, who writes the code (Haiku 5.5, a Codex
model, or an Opus 5.5 worker), at what effort, and when to escalate. GSwitch and
the Codex plugin are unchanged underneath: account failover, `invoke`,
`gswitch-review`, Auto Wake and the task view work as described in
[`invoke-mode-guide.md`](./invoke-mode-guide.md).

Disable the plugin and every session behaves exactly as before.

## Principles

- The orchestrator only makes decisions. Mechanics (settings, scope checks,
  limits, usage reading, copying worktree results back, recording unfinished
  work) run in scripts and hooks, never through the model.
- Nothing is written into the project. All router data lives in
  `~/.gswitchtool-router/` (Dev: `~/.gswitchtool-router-dev/`).
- Tool facts beat claims: the orchestrator trusts verify results, git facts and
  warning lines, the same rule as for Codex.

## Modes

| Mode | Who writes code | Needs Invoke Mode |
| --- | --- | --- |
| `off` (installed default) | The orchestrator itself, no routing: a normal session | No |
| `mixed` | Haiku or Codex per task; Opus workers only as the last rungs | Yes |
| `codex` | Codex only; no Claude worker ever writes code | Yes |
| `claude` | Haiku, then Opus workers | No |

The router has its own switch (the mode); Invoke Mode only says whether Codex
may be used. When Invoke Mode is off, `mixed` and `codex` pause routing and the
session runs as a normal session, with one line saying so. They never start
Claude workers instead. `claude` keeps working.

The orchestrator should be Opus 5.5 (the model chosen for the session). If the
session start reports another model, the router warns once.

## Commands and settings

| You want | Command |
| --- | --- |
| Change the mode for this session | `/router:mode off\|mixed\|codex\|claude [task]` |
| See the current mode and why | `/router:mode` |
| Codex review in Claude-only mode, this session | `/router:review on\|off` |
| This project's default | `/router:default <mode>` or `/router:default review on\|off` |
| Default for all projects | add `--all` |
| Remove this project's default | `/router:default --clear` |
| One task straight to Codex, whatever the mode | `/codex:gswitch-invoke` (unchanged) |

`~/.gswitchtool-router/config.json`:

```json
{
  "default": "off",
  "claudeOnlyReview": "on",
  "projects": {
    "C:/Users/me/Desktop/Github/dentisys": { "mode": "codex" }
  }
}
```

Projects are matched by their folder path (a moved folder falls back to the
global default). Session choices live in `sessions/<session id>.json` and are
removed after 7 days. A hook adds one line with the current mode to every
message, so the mode survives long sessions and summaries.

## Workers

Claude workers are fixed agent types shipped by the router; model and effort
are part of the type and cannot be overridden:

| Worker | Model | Effort | Use |
| --- | --- | --- | --- |
| `router:haiku-low` | `claude-haiku-5-5` | low | Mechanical edits: renames, moves, simple wiring |
| `router:haiku-medium` | `claude-haiku-5-5` | medium | Normal bounded work: a small feature, tests from a spec |
| `router:haiku-high` | `claude-haiku-5-5` | high | Tricky logic that is still contained |
| `router:opus-medium` | `claude-opus-5-5` | medium | Escalation rung |
| `router:opus-high` | `claude-opus-5-5` | high | Last rung; needs the owner's approval |

Workers cannot start other agents. Each Claude worker runs in its own git
worktree; when it finishes, a script copies the result back into the working
tree, or keeps the worktree with a reason when that cannot be done cleanly.

Codex work goes through the Codex plugin's `gswitch-delegate` skill, which Opus
may use on its own only while Invoke Mode is on. It uses the same `invoke` as
`/codex:gswitch-invoke`, with the models and efforts GSwitch allows.

A hook checks every worker launch: only the five worker types (plus Codex
through `invoke`) are allowed while the router is on, a model override is
refused, and `router:opus-high` shows the owner an approval prompt.

## Routing

For each task the orchestrator weighs difficulty, risk, whether speed matters,
and (from release 2) whether it splits into independent pieces. It then writes
a brief: goal, scope (paths), and the verify command.

| Mode | Task | First worker |
| --- | --- | --- |
| `mixed` | Small, low risk, or speed matters | Haiku at low, medium or high |
| `mixed` | Hard, unclear, cross-module, long, or on the high-risk list | Codex |
| `codex` | Any | Codex, model and effort by difficulty |
| `claude` | Any | Haiku at low, medium or high |

High-risk list: credentials, account switching and failover, concurrency,
money and data logic, data deletion, release and update code, security.

## Escalation ladder

On a failed verify or a serious review finding, the task moves one rung up.
The next worker gets the brief plus what the previous one tried and why it
failed.

| Mode | Ladder |
| --- | --- |
| `mixed` | Haiku (chosen effort) → Haiku one effort higher → Codex → Opus medium → Opus high (owner approves) → stop and ask |
| `codex` | Codex → higher effort → stronger model → highest allowed → stop and ask |
| `claude` | Haiku (chosen effort) → Haiku one effort higher → Opus medium → Opus high (owner approves) → stop and ask |

A task routed straight to Codex starts at the Codex rung. In `codex` mode the
orchestrator never writes the code itself after the last rung; it reports what
each rung tried and asks.

## Scope

Every worker gets a scope (path globs). The orchestrator writes it generously:
the task's files plus their tests and type files. Build output and git-ignored
files never count as out of scope.

- Claude workers: a hook blocks edits outside the scope before they happen.
- Codex: the invoker approves in-scope file changes and declines out-of-scope
  ones before they happen. Edits made through shell commands are still caught
  afterwards by the `WARNING: changed outside --scope` line and undone unless
  approved.

A blocked worker stops and returns a scope request: file, reason, intended
change. The orchestrator then:

- approves it itself when the file is closely tied to the task and low risk
  (a matching test, a type file, the same module), and resumes the worker with
  the wider scope;
- asks the owner when the file is critical: anything on the high-risk list;
  config, build, CI or release files; deleting files; protected text; anything
  outside the repository; or a much wider scope;
- denies it when the file is unrelated.

The final report lists every scope request and who decided it.

## After each worker

1. A script runs the verify command and reports git facts and scope warnings
   in the same format as `invoke` (for Codex, `invoke` already did this).
2. Review: `gswitch-review` runs in `mixed` and `codex` mode. In `claude` mode it
   runs when the review setting is on (default) and Invoke Mode is on; otherwise
   the orchestrator reviews the diff itself, and the report says why.
3. Pass: the orchestrator reports. Fail: next rung.

The report says what changed, which worker did it (model and effort), every
escalation, scope requests, review result, and what was not tested.

## Claude usage

The orchestrator and Claude workers share the Claude account; nothing switches
Claude accounts, and hitting the limit stops the whole session.

- A status line script saves the 5-hour usage and its reset time to
  `~/.gswitchtool-router/usage.json`. Claude Code gives usage only to status
  line scripts, only for claude.ai plans, and only after the first reply in a
  session. A status line you already use is run by the router's script and its
  output kept.
- When 30% or less of the 5-hour window is left, Claude workers stop:
  `mixed` sends new work to Codex and skips the Opus rungs; `claude` stops and
  asks the owner.
- Graceful wrap-up: no new workers start; running ones finish their step; a
  script records unfinished work (tasks, kept worktrees, Codex threads, next
  steps, reset time) under `~/.gswitchtool-router/wrapups/`. The next session
  in that project is told about it and offers to resume, discard, or hand the
  work to Codex.
- Without usage data (no status line support, API billing, no reply yet) the
  threshold does not apply; the report says so once.

## Releases

- Release 1: plugin, modes and settings, review setting, workers, routing,
  escalation ladder, scope blocking for Claude workers and Codex, usage
  threshold and wrap-up.
- Release 2: splitting a task into parallel pieces, after a real parallel
  conflict test has passed.

## Testing and Dev

`pnpm run plugin:dev` also builds `router-dev`, which uses `codex-dev` and
`~/.gswitchtool-router-dev/`. Not provable by unit tests and checked by hand in a
real session: hook inputs for subagents, worktree isolation, the approval
prompt for `opus-high`, status line support in the desktop app, and Codex's
behavior after a declined file change.
