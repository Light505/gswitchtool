---
name: stats
description: Show how each model did on routed tasks, by difficulty.
disable-model-invocation: true
---
<!-- Added by Light505 for gswitchtool (2026). -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs" stats $ARGUMENTS`

Show the output as-is. Optional arguments: `--project <dir>` and `--since <days>`.
The GSwitch app's Results screen shows the same data.

Columns: Model (plain name and effort, for example "Codex Sol 6.1, low"),
Difficulty, Codex speed (Fast, Normal or Mixed for Codex jobs; `-` for Claude and
old unlinked jobs), Tasks, Passed, Success (Passed / Tasks), Typical time ("N min"
or "N s"), Typical tokens, Typical cost ("$0.00") and Codex jobs.

Tasks and Passed count worker result records; orchestrator records
(`--worker orchestrator`) are not worker attempts and show on a separate
"Orchestrator edits" line. Each failed escalation counts as a task. Typical time
and tokens use GSwitch’s `codex-runs.jsonl` for linked Codex jobs and matched hook observations (session, worker, agent ID), combining
both completion hooks without counting the telemetry twice. Missing metrics
show `-`. Typical cost is estimated from the transcript and the price table in
`docs/model-benchmarks.md`, with cache reads priced as cached input; Codex attempts
have no transcript estimate. Codex jobs counts distinct linked job IDs per row. Filters select
result records; `--since` is elapsed days, including fractions.

The "Fast vs Normal" lines compare each Codex model’s typical run time when both
speeds have timed runs.
