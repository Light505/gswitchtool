// Added by Light505 for gswitchtool (2026): offline rollback selection and token-boundary checks.
import assert from "node:assert/strict";
import test from "node:test";
import { availableReleases, installerResponse, selectRelease } from "./rollback.mjs";

const api = "https://api.github.com/repos/Light505/gswitchtool/releases/assets/123";
function release(version, extra = {}) {
  return { tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [{ name: `GSwitch-Claude-Tool_${version}_x64-setup.exe`, url: api }], ...extra };
}

test("selects the highest stable version below GitHub's latest, with numeric ordering", () => {
  const latest = release("1.11.0");
  const releases = [release("1.8.0"), release("1.9.0"), latest, release("1.10.0"),
    release("1.12.0"), release("1.10.1", { draft: true }), release("1.10.2", { prerelease: true }),
    release("1.10.3-beta.1"), release("1.10.4+build"), release("1.010.5"), release("1.10"),
    release("1.10.6", { tag_name: "1.10.6" })];
  assert.equal(selectRelease(releases, { latest }).version, "1.10.0");
  assert.equal(selectRelease(releases, { to: "1.8.0" }).version, "1.8.0");
  assert.deepEqual(availableReleases(releases).map((r) => r.tag_name),
    ["v1.12.0", "v1.11.0", "v1.10.0", "v1.9.0", "v1.8.0"]);
  assert.equal(releases[0].tag_name, "v1.8.0", "does not mutate the input");
});

test("does not skip a broken selected release or offer an equal/newer release", () => {
  const latest = release("1.8.0");
  assert.throws(() => selectRelease([latest, release("1.9.0")], { latest }), /No previous/);
  assert.throws(() => selectRelease([release("1.7.0", { assets: [] }), release("1.6.0")], { latest }), /no Windows installer/);
  assert.throws(() => selectRelease([release("1.7.0", { assets: [
    { name: "GSwitch-Claude-Tool_1.7.0_x64-setup.exe", url: "https://example.com/setup.exe" },
  ] })], { latest }), /not a trusted/);
  assert.throws(() => selectRelease([latest], { to: "v1.8.0" }), /X.Y.Z/);
  assert.throws(() => selectRelease([latest], { to: "1.7.0" }), /unavailable/);
  assert.throws(() => selectRelease([latest], { latest: release("1.9.0-beta.1") }), /no stable/);
});

test("refuses versions that cannot read accounts in ~/.gswitchtool", () => {
  const releases = [release("1.1.2"), release("1.1.1"), release("1.0.24")];
  assert.equal(selectRelease(releases, { to: "1.1.2" }).version, "1.1.2");
  assert.throws(() => selectRelease(releases, { to: "1.1.1" }), /before 1\.1\.2/);
  assert.throws(() => selectRelease(releases, { latest: release("1.1.2") }), /before 1\.1\.2/);
});

test("asset download sends the token only to the repository API, never to a redirect", async () => {
  const requests = [];
  const response = await installerResponse(api, "test-only-token", async (url, options) => {
    requests.push({ url, ...options });
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/example" } })
      : new Response("installer");
  });
  assert.equal(await response.text(), "installer");
  assert.equal(requests[0].headers.Authorization, "Bearer test-only-token");
  assert.equal(requests[0].headers.Accept, "application/octet-stream");
  assert.equal(requests[0].redirect, "manual");
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(requests[1].redirect, "manual");
});

test("untrusted API urls and insecure redirects fail without sending credentials", async () => {
  for (const url of ["https://api.github.com/repos/other/repo/releases/assets/123", `${api}?x=1`, `${api}/../2`,
    "https://api.github.com.evil.example/repos/Light505/gswitchtool/releases/assets/123"]) {
    await assert.rejects(installerResponse(url, "test-only-token", () => assert.fail("must not fetch")), /not a trusted/);
  }
  let calls = 0;
  await assert.rejects(installerResponse(api, "test-only-token", async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://example.com/setup.exe" } });
  }), /redirect is invalid/);
  assert.equal(calls, 1);
});
