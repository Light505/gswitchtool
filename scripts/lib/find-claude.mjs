// Added by Light505 for gswitchtool (2026).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function children(dir) {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function bundled(base) {
  return children(base)
    .flatMap(children)
    .map((dir) => join(dir, "claude.exe"))
    .filter((file) => existsSync(file));
}

export function findClaude(env = process.env) {
  if (spawnSync("claude", ["--version"], { stdio: "ignore", shell: true, env }).status === 0) {
    return "claude";
  }
  const bases = [];
  if (env.APPDATA) bases.push(join(env.APPDATA, "Claude", "claude-code"));
  if (env.LOCALAPPDATA) {
    for (const pkg of children(join(env.LOCALAPPDATA, "Packages"))) {
      if (/[\\/]Claude_[^\\/]+$/.test(pkg)) {
        bases.push(join(pkg, "LocalCache", "Roaming", "Claude", "claude-code"));
      }
    }
  }
  return bases
    .flatMap(bundled)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
