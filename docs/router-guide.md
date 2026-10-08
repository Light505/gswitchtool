# Router guide

The router is an optional Claude Code plugin (`router@gswitchtool`) that sits on
top of the Codex plugin. The Claude Code session you open is the orchestrator.
The router decides, for each coding task, who writes the code (a Claude worker
from the models you allow, or a Codex model), at what effort, and when to
escalate. GSwitch and
the Codex plugin are unchanged underneath: account failover, `invoke`,
`gswitch-review`, Auto Wake and the task view work as described in
[`invoke-mode-guide.md`](./invoke-mode-guide.md).

Disable the plugin and every session behaves exactly as before.

The router never talks to Codex or your accounts directly: Codex tasks go
through the Codex plugin to the app, which applies your Invoke Mode rules. See
[the three parts](./invoke-mode-guide.md#the-three-parts) for how they fit.

## Install

Install the Codex plugin first ([`invoke-mode-guide.md`](./invoke-mode-guide.md#4-install-the-claude-code-plugin)), then:

```
/plugin marketplace update gswitchtool
/plugin install router@gswitchtool
```

Update it with `/plugin update router@gswitchtool` and start a new session. It
starts in mode `off`; turn it on with `/router:mode`.

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
| `mixed` | An allowed Claude worker or Codex per task; stronger Claude models only as the last rungs | Yes |
| `codex` | Codex only; no Claude worker ever writes code | Yes |
| `claude` | Allowed Claude workers, lowest model first | No |

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
| Which Claude models and efforts workers may use | `/router:allow [<model> <efforts>\|--reset]` |
| Success rate, time and tokens per worker and difficulty | `/router:stats` |
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

- Start the Claude Code session in the repository folder itself. The router uses the session's project folder (`CLAUDE_PROJECT_DIR`) for worktrees, `router apply` and the results log. Changing the folder later in the session does not change it. A folder that is not a git repository cannot be used for worker worktrees: the router ignores it for dependency links, and `/router:mode` warns that the session should start in the repository folder.
- Set `"worktree": { "baseRef": "head" }` in the project's Claude Code settings. Without it, Claude Code starts each worker's worktree from the remote's default branch (`origin/HEAD`, usually `main`), not from the branch you are on. When a mode is on, `/router:mode` and the session start warn if it is missing. The router reads `~/.claude/settings.json`, then `.claude/settings.json` and `.claude/settings.local.json` in the project; the later file wins.
- The Claude Code desktop app does not run status line commands, so the router's Claude 5h usage stays "unknown" there and the 30% rule cannot apply. It works in the terminal CLI.

## Workers

Claude workers are agent types shipped by the router; model and effort are
part of the type and cannot be overridden. Worker types use `router:<model>-<effort>`. Models, from lowest to highest,
are `haiku` (`claude-haiku-5-5`), `sonnet` (`claude-sonnet-5-5`),
and `opus` (`claude-opus-5-5`). Every model has
`low`, `medium`, `high`, `xhigh`, and `max` efforts, in that order: 15 types.
The files are generated by `scripts/gen-agents.mjs` from `templates/worker.md`.
More models can be added by extending the model list in `scripts/workers.mjs`
and regenerating the agents.

The global `claudeAllowed` setting in `config.json` chooses which workers may
start. The default allows Haiku low and medium, every Sonnet effort and every
Opus effort; the ladders below use only some of them.
Missing or corrupt settings
use this default; unknown models and efforts are ignored. An empty object
allows no Claude workers. Project and session settings do not override it.

`/router:allow` shows the list. `/router:allow <model> <effort,effort|all|none>`
replaces that model's efforts; `/router:allow --reset` restores the default.
For example, `/router:allow sonnet medium,high` enables those Sonnet workers.
Bad input leaves the config unchanged.

A Claude worker that costs more per attempt than Opus medium (~$1.45) needs the
owner's approval: Opus high, Haiku max, Sonnet xhigh, Opus xhigh, Opus max and
Sonnet max. The rule reads each worker's cost from `scripts/workers.mjs`, so it
follows the data. The prompt names the worker and the task. Routing and the escalation ladders skip workers that are
not allowed.

Workers cannot start other agents. Each Claude worker runs in its own git
worktree; when it finishes, a script copies the result back into the working
tree, or keeps the worktree with a reason when that cannot be done cleanly.

Codex work goes through the Codex plugin's `gswitch-delegate` skill, which Opus
may use on its own only while Invoke Mode is on. It uses the same `invoke` as
`/codex:gswitch-invoke`, with the models and efforts GSwitch allows.

A hook checks every worker launch: only allowed router worker types (plus
Codex through `invoke`) may write code while the router is on; a model
override is refused, and the approval rule above applies.

## Routing

For each task the orchestrator judges its difficulty, writes a brief (goal,
scope and verify command) and starts at that difficulty's default worker. It
moves up the mode's ladder only after a failure: a failed verify or a serious
review finding. The owner may name a different start for a task.

| Difficulty | `claude` | `mixed` | `codex` |
| --- | --- | --- | --- |
| Trivial: rename, move, simple wiring, one-file mechanical edit | Haiku low | Haiku low | Luna max |
| Small: a bounded change in one or two files with a clear spec | Haiku low | Haiku low | Luna max |
| Moderate: a normal feature or tests from a spec, a few files | Haiku medium | Haiku low | Luna max |
| Hard: unclear, cross-module, long, or needs design | Sonnet low | Sol low | Sol low |
| High-risk | Opus medium | Sol xhigh | Sol xhigh |

High-risk list: credentials, account switching and failover, concurrency,
money and data logic, data deletion, release and update code, security. These
start stronger on purpose: a wrong change that passes the tests costs more
there than a few extra cents.

## Escalation ladders

| Mode | Ladder |
| --- | --- |
| `claude` | Haiku low → Haiku medium → Sonnet low → Sonnet medium → Sonnet high → Opus medium → Opus high (owner approves) → Sonnet max (owner approves) → stop and ask |
| `mixed` | Haiku low → Luna max → Sol low → Sol medium → Sol xhigh → Sonnet max (owner approves) → stop and ask |
| `codex` | Luna max → Sol xhigh → stop and ask (a hard task starts at Sol low, then Sol xhigh) |

The next worker gets the brief plus what the previous one tried and why it
failed. Rungs that are not allowed are skipped. Along each ladder every rung
costs more and is stronger than the one before.

## How the defaults were chosen

Capability and cost come from one source, Artificial Analysis, so every model
is measured the same way: the Coding Agent Index (real Claude Code and Codex
sessions; cost per task at API list prices, counting input, cached input,
cache writes and output) where it has a number, and its Intelligence Index runs
for Opus below max. All numbers, prices and sources are in
[`model-benchmarks.md`](./model-benchmarks.md).

For every possible start, a script computed the expected total cost to solve a
task: each attempt's cost plus about $0.30 of orchestrator and review overhead,
times the chance the task gets that far, with failures counted as mostly caused
by difficulty (a task one worker fails is likely hard for the next one too).
Easier difficulties fail less often (assumed: moderate half as often as the
benchmark's hard tasks, small a quarter, trivial a tenth). Each default is the
cheapest start, or within 10% of it and faster. Escalation steps that cost more
than they add are left out of the ladders.

The result: cheap first attempts pay off, because a failure costs little
(Haiku low $0.14, Sonnet max $14.19). Starting moderate work at Opus medium
would only pay with about $3 of overhead per attempt.

Limits: one benchmark of hard agentic tasks, so one or two points are noise;
Opus below max is estimated from the Intelligence Index runs; plan limits count
usage their own way, which API cost only approximates; time is not part of the
cost (a failed Haiku or Luna attempt adds 10 to 20 minutes). Recheck when models
or prices change and update `model-benchmarks.md`, this guide and the route
skill together.

A task routed straight to Codex starts at a Codex rung. In `codex` mode the
orchestrator never writes the code itself after the last rung; it reports what
each rung tried and asks.

## Results log

Every attempt is logged to `~/.gswitchtool-router/results.jsonl` (never in the
project), so the ladders can move from benchmark numbers to your own:

- When a Claude worker stops, a hook reads its transcript and records the
  worker's total so far: duration and tokens of all its runs (idle time between
  a stop and a resume is excluded). Tokens count input, cache writes, cache
  reads and output; each API response counts once.
- The orchestrator records each attempt's outcome with `router result`: task
  id and short title, difficulty, worker, start or escalation, pass or fail and
  why, and for Codex the GSwitch job and thread, which link to GSwitch's
  Activity numbers.
- `/router:stats` shows attempts, success rate, median time and tokens per
  worker and difficulty.
- `node scripts/router-ladder-calc.mjs --results <file>` prints your observed
  success rate next to the assumed one once a worker and difficulty has 10 or
  more results. The defaults change only when you decide so.

## Scope

Every worker gets a scope (path globs). The orchestrator writes it generously:
the task's files plus their tests and type files. Build output and git-ignored
files never count as out of scope.

- Claude workers: a hook blocks edits outside the scope before they happen.
- Codex: the invoker approves in-scope file changes and declines out-of-scope
  ones before they happen. Edits made through shell commands are still caught
  afterwards by the `WARNING: changed outside --scope` line and undone unless
  approved.

The hook fails closed for workers: if the router itself errors, or a worker has
no recorded scope, the worker's edit is denied; only the orchestrator's own
edits stay allowed so a broken router never locks the owner out. Claude Code
deletes a worker's worktree when its run changed nothing, and a resumed worker
would then edit the main checkout, so such edits are denied (`WORKTREE GONE`)
and the orchestrator starts a new worker instead of resuming.

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
   Untracked files that are identical to the main worktree's copy (Claude Code
   copies `.claude/settings.local.json` into every worker worktree) are not
   counted as worker changes and are skipped by `apply`.
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
- When 30% or less of the 5-hour window is left, every Claude worker type stops:
  `mixed` sends new work to Codex and skips the Claude rungs; `claude` stops and
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
prompt for workers above Opus medium's cost, status line support in the desktop app, and Codex's
behavior after a declined file change.
