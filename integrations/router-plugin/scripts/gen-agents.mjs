// Added by Light505 for gswitchtool (2026).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { models, efforts, workerNames } from "./workers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "agents");
const notice = "<!-- Added by Light505 for gswitchtool (2026). -->";
const template = fs.readFileSync(path.join(root, "templates", "worker.md"), "utf8").replace(/\r\n/g, "\n");
if (!template.startsWith(`${notice}\n`)) throw new Error("Worker template must start with the notice");
const body = template.slice(notice.length + 1).trimEnd();
const check = process.argv.includes("--check");
const different = [];
if (!check) fs.mkdirSync(directory, { recursive: true });
for (const model of models) for (const effort of efforts) {
  const name = `${model.short}-${effort}`;
  const file = path.join(directory, `${name}.md`);
  const text = `---\nname: ${name}\ndescription: ${JSON.stringify(`Router worker: ${model.display} at ${effort} effort. Started only by the router.`)}\nmodel: ${model.id}\neffort: ${effort}\nisolation: worktree\ntools: Read, Edit, Write, Glob, Grep, Bash\n---\n${notice}\n${body}\n`;
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) different.push(`${name}.md`);
  } else fs.writeFileSync(file, text);
}
if (fs.existsSync(directory)) for (const file of fs.readdirSync(directory)) {
  if (file.endsWith(".md") && !workerNames.includes(file.slice(0, -3))) {
    if (check) different.push(file);
    else fs.unlinkSync(path.join(directory, file));
  }
}
if (different.length) {
  process.stderr.write(`Generated agents differ: ${different.join(", ")}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Agents: ${check ? "checked" : "generated"} ${workerNames.length}\n`);
