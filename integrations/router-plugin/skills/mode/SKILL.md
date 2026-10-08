---
name: mode
description: Show the router mode, review setting and allowed workers from GSwitch's Claude Code setup.
disable-model-invocation: true
---
<!-- Added by Light505 for gswitchtool (2026). -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs" mode "${CLAUDE_SESSION_ID}" "${CLAUDE_PROJECT_DIR}"`

If any arguments were supplied, print exactly:
`Change the setup in GSwitch: Claude Code button.`
Change nothing and do not start a task from the arguments.
With no arguments, report the status output, including allowed workers and warnings.
