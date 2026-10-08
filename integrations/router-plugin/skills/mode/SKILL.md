---
name: mode
description: Set or show the router mode for this session.
disable-model-invocation: true
---
<!-- Added by Light505 for gswitchtool (2026). -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs" mode "${CLAUDE_SESSION_ID}" "${CLAUDE_PROJECT_DIR}" '$0'`

Report the output in one line. If the arguments contain a task after the mode, start that task now.
