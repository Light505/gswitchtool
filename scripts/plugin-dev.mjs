// Added by Light505 for gswitchtool (2026): builds and installs the Dev plugin.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findClaude } from "./lib/find-claude.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "integrations", "codex-plugin-cc", "plugins", "codex");
const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
const destination = path.join(home, ".gswitchtool-dev-plugin");
const pluginDestination = path.join(destination, "plugins", "codex-dev");
const noInstall = process.argv.includes("--no-install");

function command(claude, args) {
  const run = spawnSync(claude, args, {
    cwd: root,
    encoding: "utf8",
    shell: claude === "claude",
    windowsHide: true
  });
  if (run.error || run.status !== 0) {
    throw new Error((run.stderr || run.error?.message || `Claude Code exited with ${run.status}`).trim());
  }
  return run.stdout || "";
}

const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
if (revision.status !== 0) throw new Error("Could not read the current Git commit.");
const shortCommit = revision.stdout.trim();

rmSync(pluginDestination, { recursive: true, force: true });
mkdirSync(path.dirname(pluginDestination), { recursive: true });
cpSync(source, pluginDestination, { recursive: true });

const manifestPath = path.join(pluginDestination, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.name = "codex-dev";
manifest.description = `[dev] ${manifest.description}`;
// A build stamp as well as the commit: Claude Code updates a plugin only when
// its version changes, and uncommitted edits keep the same commit.
manifest.version = `${manifest.version}-dev.${shortCommit}.${Date.now().toString(36)}`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  path.join(pluginDestination, "gswitch-target.json"),
  `${JSON.stringify({ dataDir: ".gswitchtool-dev", appName: "GSwitch Claude Tool (Dev)" }, null, 2)}\n`
);

for (const area of ["commands", "skills", "agents"]) {
  const areaPath = path.join(pluginDestination, area);
  try {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          let text = readFileSync(full, "utf8");
          const newline = text.includes("\r\n") ? "\r\n" : "\n";
          text = text.replaceAll("/codex:", "/codex-dev:").replaceAll("GSwitch Claude Tool", "GSwitch Claude Tool (Dev)");
          if (area === "skills" && full.endsWith(path.join("gswitch-review", "SKILL.md"))) {
            text = text.replace(
              /^description:.*$/m,
              "description: Run only when the user types /codex-dev:gswitch-review for a read-only Codex review through GSwitch Invoke Mode."
            );
            text = text.replace(/^(---\r?\n[\s\S]*?)(---\r?\n)/, (match, frontmatter, end) =>
              /^disable-model-invocation:/m.test(frontmatter)
                ? `${frontmatter.replace(/^disable-model-invocation:.*$/m, "disable-model-invocation: true")}${end}`
                : `${frontmatter}disable-model-invocation: true${newline}${end}`
            );
          }
          writeFileSync(full, text);
        }
      }
    };
    walk(areaPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const marketplaceDir = path.join(destination, ".claude-plugin");
const routerDestination = path.join(destination, "plugins", "router-dev");
// Both copies share the same suffix and are replaced independently on rerun.
const relativeRouter = path.relative(destination, routerDestination);
if (relativeRouter.startsWith("..") || path.isAbsolute(relativeRouter)) throw new Error("Invalid Dev router destination.");
rmSync(routerDestination, { recursive: true, force: true });
cpSync(path.join(root, "integrations", "router-plugin"), routerDestination, { recursive: true });
// Copy generated agents, command skills and the shared template together.
const generated = spawnSync(process.execPath, [path.join(routerDestination, "scripts", "gen-agents.mjs"), "--check"], {
  encoding: "utf8", windowsHide: true
});
if (generated.status !== 0) throw new Error(generated.stderr || generated.error?.message || "Router agents are not generated.");
const routerManifestPath = path.join(routerDestination, ".claude-plugin", "plugin.json");
const routerManifest = JSON.parse(readFileSync(routerManifestPath, "utf8"));
routerManifest.name = "router-dev";
routerManifest.description = `[dev] ${routerManifest.description}`;
routerManifest.version += manifest.version.slice(manifest.version.indexOf("-dev."));
writeFileSync(routerManifestPath, `${JSON.stringify(routerManifest, null, 2)}\n`);
writeFileSync(path.join(routerDestination, "router-target.json"), `${JSON.stringify({ $comment: "Added by Light505 for gswitchtool (2026).", dataDir: ".gswitchtool-router-dev", appDataDir: ".gswitchtool-dev" }, null, 2)}\n`);
function rewriteRouterMarkdown(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) rewriteRouterMarkdown(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const text = readFileSync(full, "utf8").replaceAll("codex:", "codex-dev:").replaceAll("router:", "router-dev:");
      writeFileSync(full, text);
    }
  }
}
rewriteRouterMarkdown(routerDestination);
mkdirSync(marketplaceDir, { recursive: true });
writeFileSync(
  path.join(marketplaceDir, "marketplace.json"),
  `${JSON.stringify({
    name: "gswitchtool-dev",
    owner: { name: "Light505" },
    metadata: { version: manifest.version, description: "Development Claude Code plugin for GSwitch." },
    plugins: [{
      name: "codex-dev",
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      source: "./plugins/codex-dev"
    }, {
      name: "router-dev",
      version: routerManifest.version,
      description: routerManifest.description,
      author: routerManifest.author,
      source: "./plugins/router-dev"
    }]
  }, null, 2)}\n`
);

console.log(`Built Dev plugin at ${pluginDestination}`);
console.log(`Built Dev plugin at ${routerDestination}`);
if (noInstall) process.exit(0);

const claude = findClaude();
if (!claude) throw new Error("Claude Code was not found. Open Claude's desktop app once, or install the Claude Code CLI.");
const marketplaces = command(claude, ["plugin", "marketplace", "list"]);
if (marketplaces.includes("gswitchtool-dev")) {
  command(claude, ["plugin", "marketplace", "update", "gswitchtool-dev"]);
  console.log("Updated Claude Code marketplace gswitchtool-dev.");
  command(claude, ["plugin", "update", "codex-dev@gswitchtool-dev"]);
  console.log("Updated Claude Code plugin codex-dev@gswitchtool-dev.");
} else {
  command(claude, ["plugin", "marketplace", "add", destination]);
  console.log("Added Claude Code marketplace gswitchtool-dev.");
  command(claude, ["plugin", "install", "codex-dev@gswitchtool-dev"]);
  console.log("Installed Claude Code plugin codex-dev@gswitchtool-dev.");
}
const installedPlugins = command(claude, ["plugin", "list"]);
const routerAction = installedPlugins.includes("router-dev") ? "update" : "install";
command(claude, ["plugin", routerAction, "router-dev@gswitchtool-dev"]);
console.log(`${routerAction === "update" ? "Updated" : "Installed"} Claude Code plugin router-dev@gswitchtool-dev.`);
console.log("Start a new Claude Code session to use the updated codex-dev and router-dev plugins.");
