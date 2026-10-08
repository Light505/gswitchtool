---
name: stats
description: Show router results by worker and task difficulty.
disable-model-invocation: true
---
<!-- Added by Light505 for gswitchtool (2026). -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs" stats $ARGUMENTS`

Show the output as-is. Optional arguments: `--project <dir>` and `--since <days>`.

Attempts and passes count worker result records; orchestrator records
(`--worker orchestrator`) are not attempts and show on a separate count line.
Each failed escalation counts as an attempt. Success is passes / attempts. Median ms and median tokens
use matched hook observations (session, worker, agent ID), combining
both completion hooks without counting the telemetry twice. Missing metrics
show `-`. Codex jobs counts distinct linked job IDs per row. Filters select
result records; `--since` is elapsed days, including fractions.
