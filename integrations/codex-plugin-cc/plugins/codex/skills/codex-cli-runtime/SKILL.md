---
name: codex-cli-runtime
description: Internal helper contract for direct Codex task execution
user-invocable: false
---

<!-- Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool. -->

# Codex Runtime

Use the companion helper for `task` execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [arguments]
```

- Use one `task` invocation and return its stdout unchanged.
- Add `--write` unless the user requests read-only diagnosis, research, or review.
- Leave model and effort unset unless the user chooses them.
- Map `spark` to `gpt-5.3-codex-spark`.
- Map `--resume` to `--resume-last`; strip `--fresh` without adding resume routing.
- Do not inspect the repository or do follow-up work in this helper flow.
