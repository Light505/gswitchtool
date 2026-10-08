---
description: "Show GSwitch Invoke Mode status: allowed Codex models and efforts, defaults, running workers, and whether Codex is signed out"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- Added by Light505 for gswitchtool (2026). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" invoke-status`

Show the output to the user as it is, without changes or extra commentary.
