#!/usr/bin/env node
// Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
import { readClaudeSetup } from "./lib/gswitch.mjs";

const lines = {
  "claude-only": "GSwitch setup: Claude only. Do not use Codex: no gswitch-delegate, gswitch-review or /codex commands unless the user asks.",
  "claude-codex": "GSwitch setup: Claude + Codex. Send bounded, self-contained coding tasks to Codex with the gswitch-delegate skill; keep decisions, design, debugging that needs this conversation, and edits shorter than their brief. After non-trivial changes run gswitch-review.",
  router: "GSwitch setup: Router. Follow the Router: line. If no Router: line appears, the router plugin is not installed: work as Claude only and tell the user once."
};

try {
  const line = lines[readClaudeSetup()?.setup];
  if (line) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: line
  } })}\n`);
} catch {
  // Setup context must never prevent a prompt from reaching Claude.
}
