// Added by Light505 for gswitchtool (2026): publishes an update of the installed app.
// Usage: pnpm run release -- --notes "What changed"
//
// Builds the installed identity from a clean main that matches GitHub, signs it
// with the updater key kept outside the repository, and publishes a GitHub
// release of the private repository with the installer and latest.json. The
// installed app offers it to its user, who decides whether to install it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Light505/gswitchtool";
const API = "https://api.github.com";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = process.env.GSWITCH_UPDATER_KEY ?? join(homedir(), ".tauri", "gswitchtool-updater.key");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

// 1. Only a clean main that matches GitHub is released.
if (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") {
  fail("releases are made only from main. Run: git checkout main && git pull");
}
// Compare content, not file status: Tauri builds rewrite Cargo.toml line endings.
const changed = spawnSync("git", ["diff", "--quiet", "HEAD"], { cwd: root }).status !== 0;
if (changed || git(["ls-files", "--others", "--exclude-standard"]) !== "") {
  fail("main has uncommitted changes. Commit or stash them first.");
}
git(["fetch", "--quiet", "origin", "main"]);
const counts = git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
if (counts !== "0\t0" && counts !== "0 0") {
  fail("main must match GitHub before a release. Run: git pull, then git push.");
}
if (spawnSync(process.execPath, ["scripts/sync-version.mjs", "--check"], { cwd: root }).status !== 0) {
  fail("versions disagree. Run: pnpm run version:sync");
}
if (!existsSync(keyPath)) {
  fail(`the updater signing key is missing at ${keyPath} (or set GSWITCH_UPDATER_KEY).`);
}

const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const tag = `v${version}`;
const notes = option("--notes") ?? `GSwitch Claude Tool ${version}`;
const commit = git(["rev-parse", "HEAD"]);

// 2. The GitHub sign-in Git already uses; never printed.
const credential = git(["credential", "fill"], "protocol=https\nhost=github.com\n\n") ?? "";
const token = credential.split(/\r?\n/).find((line) => line.startsWith("password="))?.slice("password=".length);
if (!token) {
  fail("Git has no saved GitHub sign-in. Run git pull once to sign in, then try again.");
}

async function github(path, { method = "GET", body, headers = {}, base = API } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    body,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gswitchtool-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} to ${method} ${path.split("?")[0]}`);
  }
  return response.status === 204 ? {} : response.json();
}

if (await github(`/repos/${REPOSITORY}/releases/tags/${tag}`)) {
  fail(`${tag} is already released. Raise "version" in src-tauri/tauri.conf.json, run pnpm run version:sync, and commit it.`);
}

// 3. Build and sign the installed identity.
console.log(`Building GSwitch Claude Tool ${version} from main at ${commit.slice(0, 7)}.`);
const args = [
  "tauri",
  "build",
  "--config",
  "src-tauri/tauri.main.conf.json",
  "--config",
  JSON.stringify({ bundle: { createUpdaterArtifacts: true } }),
];
const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
};
// Reuse the pnpm that ran this script (it may come from Corepack, not PATH).
const pnpm = process.env.npm_execpath;
const build =
  pnpm?.endsWith(".js") || pnpm?.endsWith(".cjs")
    ? spawnSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: "inherit", env })
    : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });
if (build.status !== 0) {
  fail("the build failed; nothing was published.");
}
const bundle = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = join(bundle, `GSwitch Claude Tool_${version}_x64-setup.exe`);
if (!existsSync(installer) || !existsSync(`${installer}.sig`)) {
  fail(`the signed installer was not found in ${bundle}.`);
}

// 4. Publish: a draft first, made the latest release only once complete.
const release = await github(`/repos/${REPOSITORY}/releases`, {
  method: "POST",
  body: JSON.stringify({
    tag_name: tag,
    target_commitish: commit,
    name: `GSwitch Claude Tool ${version}`,
    body: notes,
    draft: true,
  }),
});
try {
  const upload = (name, body, type) =>
    github(`/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body,
      base: "https://uploads.github.com",
      headers: { "Content-Type": type },
    });
  const asset = await upload(
    `GSwitch-Claude-Tool_${version}_x64-setup.exe`,
    readFileSync(installer),
    "application/octet-stream",
  );
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": { signature: readFileSync(`${installer}.sig`, "utf8").trim(), url: asset.url },
    },
  };
  const manifestPath = join(bundle, "latest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await upload("latest.json", readFileSync(manifestPath), "application/json");
  await github(`/repos/${REPOSITORY}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({ draft: false, make_latest: "true" }),
  });
} catch (error) {
  await github(`/repos/${REPOSITORY}/releases/${release.id}`, { method: "DELETE" }).catch(() => {});
  fail(`${error.message}. The unfinished release was removed; nothing was published.`);
}
console.log(`Released ${tag}. Installed copies offer it on their next update check.`);
