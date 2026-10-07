// Added by Light505 for gswitchtool (2026): starts Claude Code with the
// plugin from this checkout instead of the installed one, for testing.
//
//   pnpm run claude:dev
//
// Uses `claude` from PATH when there is one; otherwise the newest Claude Code
// bundled with Claude's desktop app. On Windows the desktop app keeps it in its
// private package folder, so the path changes with every update.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = [
  "--plugin-dir",
  "integrations/codex-plugin-cc/plugins/codex",
  "--settings",
  "scripts/claude-dev-settings.json",
  ...process.argv.slice(2),
];

function children(dir) {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Every claude.exe under <base>/<version>/<build>/. */
function bundled(base) {
  return children(base)
    .flatMap(children)
    .map((dir) => join(dir, "claude.exe"))
    .filter((file) => existsSync(file));
}

function newestBundledClaude() {
  const bases = [];
  if (process.env.APPDATA) bases.push(join(process.env.APPDATA, "Claude", "claude-code"));
  if (process.env.LOCALAPPDATA) {
    for (const pkg of children(join(process.env.LOCALAPPDATA, "Packages"))) {
      if (/[\\/]Claude_[^\\/]+$/.test(pkg)) {
        bases.push(join(pkg, "LocalCache", "Roaming", "Claude", "claude-code"));
      }
    }
  }
  return bases
    .flatMap(bundled)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const onPath = spawnSync("claude", ["--version"], { stdio: "ignore", shell: true }).status === 0;
const claude = onPath ? "claude" : newestBundledClaude();
if (!claude) {
  console.error("claude:dev: Claude Code was not found. Open Claude's desktop app once, or install the Claude Code CLI.");
  process.exit(1);
}
console.log(`Starting ${claude} with this checkout's plugin…`);
const run = spawnSync(claude, args, { cwd: root, stdio: "inherit", shell: onPath });
process.exit(run.status ?? 1);
