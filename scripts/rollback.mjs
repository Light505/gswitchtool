// Added by Light505 for gswitchtool (2026): reinstall a published installed-app release.
// Usage: pnpm run rollback [-- --to 1.7.0 | -- --list]
// Git's saved sign-in stays here and goes only to this repository's GitHub API.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

class RollbackFailure extends Error {}

const API = "https://api.github.com/repos/Light505/gswitchtool";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const OLDEST_SUPPORTED = "1.1.2";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function compare(a, b) {
  const left = a.tag_name.slice(1).split(".").map(BigInt);
  const right = b.tag_name.slice(1).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? 1 : -1;
  }
  return 0;
}

export function availableReleases(releases) {
  return releases.filter((release) => !release.draft && !release.prerelease
    && typeof release.tag_name === "string" && release.tag_name.startsWith("v")
    && VERSION.test(release.tag_name.slice(1))).sort(compare);
}

export function selectRelease(releases, { to, latest } = {}) {
  const published = availableReleases(releases);
  if (to !== undefined && !VERSION.test(to)) throw new RollbackFailure("Use --to X.Y.Z.");
  if (to === undefined && (!latest || !availableReleases([latest]).length)) {
    throw new RollbackFailure("The latest published release has no stable vX.Y.Z tag.");
  }
  const selected = to !== undefined
    ? published.find((release) => release.tag_name === `v${to}`)
    : published.find((release) => compare(release, latest) > 0);
  if (!selected) throw new RollbackFailure(to ? "That published version is unavailable." : "No previous published version is available.");
  // Versions before 1.1.2 keep data in AppData and would open without the accounts in ~/.gswitchtool.
  if (compare(selected, { tag_name: `v${OLDEST_SUPPORTED}` }) > 0) {
    throw new RollbackFailure(`Versions before ${OLDEST_SUPPORTED} cannot read your saved accounts.`);
  }
  const version = selected.tag_name.slice(1);
  const name = `GSwitch-Claude-Tool_${version}_x64-setup.exe`;
  const asset = selected.assets?.find((asset) => asset.name === name);
  if (!asset) throw new RollbackFailure("The selected release has no Windows installer.");
  if (!isReleaseAsset(asset.url)) throw new RollbackFailure("The selected installer is not a trusted repository asset.");
  return { version, asset };
}

function isReleaseAsset(url) {
  return typeof url === "string" && url.startsWith(`${API}/releases/assets/`)
    && /^[0-9]+$/.test(url.slice(`${API}/releases/assets/`.length));
}

function headers(token, accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "User-Agent": "gswitchtool-rollback",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function github(path, token) {
  const response = await fetch(`${API}${path}`, {
    headers: headers(token), redirect: "error", signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw new RollbackFailure("Could not reach GitHub. Check your connection and try again."); });
  if (!response.ok) throw new RollbackFailure("GitHub could not read this repository. Check your saved GitHub sign-in and repository access.");
  return response.json().catch(() => { throw new RollbackFailure("Could not read GitHub release metadata."); });
}

// Even a redirect back to the API is followed anonymously. Never forward the token.
export async function installerResponse(url, token, fetcher = fetch) {
  if (!isReleaseAsset(url)) throw new RollbackFailure("The selected installer is not a trusted repository asset.");
  let requestHeaders = headers(token, "application/octet-stream");
  for (let redirects = 0; redirects <= 10; redirects++) {
    const response = await fetcher(url, {
      headers: requestHeaders, redirect: "manual", signal: AbortSignal.timeout(300_000),
    }).catch(() => { throw new RollbackFailure("Could not download the installer. Check your connection and try again."); });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      let next;
      try { next = new URL(location, url); } catch { throw new RollbackFailure("The installer redirect is invalid."); }
      if (!location || next.protocol !== "https:" || next.username || next.password) {
        throw new RollbackFailure("The installer redirect is invalid.");
      }
      url = next.href;
      requestHeaders = { Accept: "application/octet-stream" };
      continue;
    }
    if (!response.ok || !response.body) throw new RollbackFailure("GitHub could not provide the installer.");
    return response;
  }
  throw new RollbackFailure("The installer download redirected too many times.");
}

async function main(args) {
  // pnpm may preserve the argument separator.
  args = args.filter((arg) => arg !== "--");
  const list = args.length === 1 && args[0] === "--list";
  const to = args.length === 2 && args[0] === "--to" ? args[1] : undefined;
  if (args.length && !list && (to === undefined || !VERSION.test(to))) {
    throw new RollbackFailure("Usage: pnpm run rollback [-- --to X.Y.Z | -- --list]");
  }
  if (!list && process.platform !== "win32") throw new RollbackFailure("This recovery command runs the Windows installer.");
  const credential = spawnSync("git", ["credential", "fill"], {
    cwd: root, encoding: "utf8", input: "protocol=https\nhost=github.com\n\n",
    timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  const token = credential.status === 0
    ? credential.stdout.split(/\r?\n/).find((line) => line.startsWith("password="))?.slice(9).trim()
    : undefined;
  if (!token) throw new RollbackFailure("Git has no saved GitHub sign-in. Run git pull once to sign in, then try again.");
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/releases?per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) throw new RollbackFailure("Could not read GitHub release metadata.");
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  if (list) {
    console.log(availableReleases(releases)
      .filter((release) => compare(release, { tag_name: `v${OLDEST_SUPPORTED}` }) <= 0)
      .map((release) => release.tag_name.slice(1)).join("\n") || "No published versions are available.");
    return;
  }
  const latest = to === undefined ? await github("/releases/latest", token) : undefined;
  const { version, asset } = selectRelease(releases, { to, latest });
  console.log(`Downloading GSwitch Claude Tool v${version}. Close GSwitch before completing the installer.`);
  const response = await installerResponse(asset.url, token);
  const directory = await mkdtemp(join(tmpdir(), "gswitchtool-rollback-"));
  const installer = join(directory, asset.name);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(installer, { flags: "wx" }))
    .catch(() => { throw new RollbackFailure("Could not save the installer in the temporary folder."); });
  console.log(`Opening the installer for v${version}. Your accounts and settings stay; newer settings may be ignored.`);
  await new Promise((done, reject) => {
    const child = spawn(installer, [], { stdio: "inherit" });
    child.once("error", () => reject(new RollbackFailure("Could not start the installer.")));
    child.once("exit", (code) => code === 0 ? done() : reject(new RollbackFailure("The installer did not finish.")));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // Only our fixed messages are printed; filesystem/provider error bodies stay private.
    console.error(`rollback: ${error instanceof RollbackFailure ? error.message : "Rollback did not finish. Try again."}`);
    process.exitCode = 1;
  });
}
