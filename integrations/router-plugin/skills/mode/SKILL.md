---
name: mode
description: Show the Automatic team setup and which Claude models it may use (set in GSwitch → Claude Code).
disable-model-invocation: true
---
<!-- Added by Light505 for gswitchtool (2026). -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs" mode "${CLAUDE_SESSION_ID}" "${CLAUDE_PROJECT_DIR}"`

If any arguments were supplied, print exactly:
`Change it in GSwitch → Claude Code.`
Change nothing and do not start a task from the arguments.
With no arguments, report the status output, including allowed workers and warnings.
