#!/usr/bin/env node
// Modified by Light505 for gswitchtool (2026). See CREDITS.md in gswitchtool.
import { readClaudeSetup } from "./lib/gswitch.mjs";

const lines = {
  "claude-only": "GSwitch setup: Claude only. Do not use Codex: no gswitch-invoke or /codex commands unless the user asks.",
  "claude-codex": "GSwitch setup: Claude + Codex. Use the gswitch-invoke skill: send bounded, self-contained coding tasks to Codex, and get a Codex review after non-trivial changes; keep decisions, design, debugging that needs this conversation, and edits shorter than their brief.",
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
