---
name: review
description: Set Codex review in Claude mode for this session.
disable-model-invocation: true
---
<!-- Added by Light505 for gswitchtool (2026). -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/router.mjs" review "${CLAUDE_SESSION_ID}" "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

Report the output in one line.
