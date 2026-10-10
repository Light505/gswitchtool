---
description: "Check that GSwitch and both plugins are set up: app running, setup, plugins, Codex sign-in, accounts Claude may use"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- Added by Light505 for gswitchtool (2026). -->

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" check`

Show the output to the user as it is, without changes or extra commentary.
