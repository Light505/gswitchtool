// Added by Light505 for gswitchtool (2026): builds the route and gswitch-invoke SKILL.md files
// from integrations/skill-text. `--check` writes nothing and exits 1 when a file differs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const textDir = path.join(root, "integrations", "skill-text");
const targets = [
  ["route.md", path.join(root, "integrations", "router-plugin", "skills", "route", "SKILL.md")],
  ["gswitch-invoke.md", path.join(root, "integrations", "codex-plugin-cc", "plugins", "codex", "skills", "gswitch-invoke", "SKILL.md")]
];
const generatedNote = "<!-- Generated from integrations/skill-text by scripts/gen-skills.mjs; edit the templates. -->";

const lf = (text) => text.replace(/\r\n/g, "\n");

function build(templateName) {
  let text = lf(readFileSync(path.join(textDir, templateName), "utf8")).replace(
    /^<!-- include: (.+?) -->$/gm,
    (_match, file) => lf(readFileSync(path.join(textDir, file.trim()), "utf8")).replace(/\n+$/, "")
  );
  // Put the note right after the template's own header comment.
  text = text.replace(/^<!--(?! include:).*-->$/m, (comment) => `${comment}\n${generatedNote}`);
  return `${text.replace(/\n+$/, "")}\n`.replaceAll("\n", "\r\n");
}

const check = process.argv.includes("--check");
const differing = [];
for (const [templateName, target] of targets) {
  const next = build(templateName);
  let current = null;
  try {
    current = readFileSync(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current === next) continue;
  differing.push(path.relative(root, target));
  if (!check) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, next);
  }
}
if (check && differing.length) {
  console.error(`Generated skills differ; run node scripts/gen-skills.mjs:\n${differing.join("\n")}`);
  process.exit(1);
}
if (!check) console.log(differing.length ? `Wrote ${differing.join(", ")}` : "Skills already up to date.");
