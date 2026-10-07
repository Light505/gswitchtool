// Added by Light505 for gswitchtool (2026): one-off Claude Code session with
// the plugin from this checkout. plugin:dev is now the normal way to install
// and update the Dev plugin.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findClaude } from "./lib/find-claude.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = [
  "--plugin-dir",
  "integrations/codex-plugin-cc/plugins/codex",
  "--settings",
  "scripts/claude-dev-settings.json",
  ...process.argv.slice(2),
];

const claude = findClaude();
if (!claude) {
  console.error("claude:dev: Claude Code was not found. Open Claude's desktop app once, or install the Claude Code CLI.");
  process.exit(1);
}
console.log(`Starting ${claude} with this checkout's plugin…`);
const run = spawnSync(claude, args, { cwd: root, stdio: "inherit", shell: claude === "claude" });
process.exit(run.status ?? 1);
