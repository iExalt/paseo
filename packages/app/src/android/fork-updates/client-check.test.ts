import { beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { forkReleaseManifestV3Fixture } from "../../../../../scripts/test-fixtures/fork-release-manifest";

const harness = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  responses: new Map<string, string | Error>(),
  fetchText: vi.fn<(url: string, maxBytes: number) => Promise<string>>(),
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => ({
    getInstalledVersion: () => "0.1.0",
    getInstalledVersionCode: () => 201000,
    fetchText: harness.fetchText,
  }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => harness.storage.set(key, value),
    multiRemove: async (keys: string[]) => keys.forEach((key) => harness.storage.delete(key)),
  },
}));
vi.mock("@getpaseo/protocol/release-manifest", async (importOriginal) => {
  const { default: signing } = await import("tweetnacl");
  return {
    ...(await importOriginal<object>()),
    PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL: Buffer.from(
      signing.sign.keyPair.fromSeed(new Uint8Array(32)).publicKey,
    ).toString("base64url"),
  };
});

import { checkForForkUpdate } from "./client";
import type { GitHubRelease } from "./release";

const releasesUrl = "https://api.github.com/repos/iExalt/paseo/releases";
const listUrl = (page = 1) => `${releasesUrl}?per_page=6&page=${page}`;
const assetUrl = (tag: string, name: string) =>
  `https://github.com/iExalt/paseo/releases/download/${tag}/${name}`;
const manifestUrl = (release: GitHubRelease) =>
  assetUrl(release.tag_name, "paseo-release-manifest.json");

function publish(version: string): GitHubRelease {
  const manifest = forkReleaseManifestV3Fixture(version);
  const text = JSON.stringify(manifest);
  const signature = Buffer.from(
    nacl.sign.detached(
      new TextEncoder().encode(text),
      nacl.sign.keyPair.fromSeed(new Uint8Array(32)).secretKey,
    ),
  ).toString("base64url");
  harness.responses.set(assetUrl(manifest.releaseTag, "paseo-release-manifest.json"), text);
  harness.responses.set(assetUrl(manifest.releaseTag, "paseo-release-manifest.sig"), signature);
  return {
    tag_name: manifest.releaseTag,
    draft: false,
    prerelease: false,
    assets: [
      { name: "paseo-release-manifest.json", size: new TextEncoder().encode(text).length },
      { name: "paseo-release-manifest.sig", size: signature.length },
      { name: "paseo.apk", size: 123 },
    ],
  };
}

function invalidate(release: GitHubRelease) {
  harness.responses.set(assetUrl(release.tag_name, "paseo-release-manifest.sig"), "invalid");
}

function setLatest(release: GitHubRelease) {
  harness.responses.set(`${releasesUrl}/latest`, JSON.stringify(release));
}

function requestedManifests() {
  return harness.fetchText.mock.calls
    .map(([url]) => url)
    .filter((url) => url.endsWith("/paseo-release-manifest.json"));
}

beforeEach(() => {
  harness.storage.clear();
  harness.responses.clear();
  harness.fetchText.mockReset();
  harness.fetchText.mockImplementation(async (url, maxBytes) => {
    const body = harness.responses.get(url);
    if (body instanceof Error) throw body;
    if (body === undefined) throw new Error(`Unexpected request: ${url}`);
    if (new TextEncoder().encode(body).length > maxBytes) {
      throw new Error("GitHub response exceeds the size limit.");
    }
    return body;
  });
});

describe("fork update release discovery", () => {
  it("verifies latest without fetching a release history larger than the native limit", async () => {
    setLatest(publish("0.1.9"));
    harness.responses.set(`${releasesUrl}?per_page=100&page=1`, " ".repeat(1_048_577));
    expect((await checkForForkUpdate()).update?.manifest.version).toBe("0.1.9");
    expect(harness.fetchText).toHaveBeenCalledTimes(3);
    expect(harness.fetchText.mock.calls[0][0]).toBe(`${releasesUrl}/latest`);
    expect(harness.fetchText.mock.calls.some(([url]) => url.includes("?per_page="))).toBe(false);
  });

  it("falls back in descending version order and stops on the first verified release", async () => {
    const latest = publish("0.1.9");
    invalidate(latest);
    setLatest(latest);
    const broken = publish("0.1.8");
    harness.responses.set(manifestUrl(broken), new Error("GitHub returned HTTP 404."));
    const valid = publish("0.1.7");
    const unused = publish("0.1.6");
    harness.responses.set(listUrl(), JSON.stringify([unused, latest, valid, broken]));
    expect((await checkForForkUpdate()).update?.manifest.version).toBe("0.1.7");
    expect(requestedManifests()).toEqual([
      manifestUrl(latest),
      manifestUrl(broken),
      manifestUrl(valid),
    ]);
  });

  it("can use the fifth fallback, but never tries a sixth or retries latest", async () => {
    const latest = publish("0.1.9");
    invalidate(latest);
    setLatest(latest);
    const older = [8, 7, 6, 5, 4, 3].map((patch) => publish(`0.1.${patch}`));
    older.slice(0, 4).forEach(invalidate);
    harness.responses.set(listUrl(), JSON.stringify([latest, ...older.slice(0, 5)]));
    harness.responses.set(listUrl(2), JSON.stringify([older[5]]));
    expect((await checkForForkUpdate()).update?.manifest.version).toBe("0.1.4");
    expect(requestedManifests()).toEqual([latest, ...older.slice(0, 5)].map(manifestUrl));
    expect(harness.fetchText.mock.calls.some(([url]) => url === listUrl(2))).toBe(false);
  });

  it("gives up after five failed fallbacks even when a sixth could verify", async () => {
    const latest = publish("0.1.9");
    invalidate(latest);
    setLatest(latest);
    const older = [8, 7, 6, 5, 4, 3].map((patch) => publish(`0.1.${patch}`));
    older.slice(0, 5).forEach(invalidate);
    harness.responses.set(listUrl(), JSON.stringify([latest, ...older.slice(0, 5)]));
    harness.responses.set(listUrl(2), JSON.stringify([older[5]]));
    await expect(checkForForkUpdate()).rejects.toThrow("No signed published");
    expect(requestedManifests()).toEqual([latest, ...older.slice(0, 5)].map(manifestUrl));
  });

  it("paginates past ineligible entries without counting them as verification attempts", async () => {
    const latest = publish("0.1.9");
    invalidate(latest);
    setLatest(latest);
    const preview = { ...publish("0.2.0"), prerelease: true };
    const draft = { ...publish("0.3.0"), draft: true };
    const unrelated = { ...publish("0.4.0"), tag_name: "probe-build" };
    const valid = publish("0.1.8");
    harness.responses.set(
      listUrl(),
      JSON.stringify([latest, preview, draft, unrelated, preview, draft]),
    );
    harness.responses.set(listUrl(2), JSON.stringify([valid]));
    expect((await checkForForkUpdate()).update?.manifest.version).toBe("0.1.8");
    expect(requestedManifests()).toEqual([manifestUrl(latest), manifestUrl(valid)]);
  });

  it("falls back when the latest endpoint fails and preserves the installed high-water version", async () => {
    harness.responses.set(`${releasesUrl}/latest`, new Error("GitHub returned HTTP 404."));
    harness.responses.set(listUrl(), JSON.stringify([publish("0.1.1")]));
    harness.storage.set("@getpaseo/fork-update/semver-v1/high-water", "0.1.2");
    expect((await checkForForkUpdate()).update).toBeNull();
    expect(harness.storage.get("@getpaseo/fork-update/semver-v1/high-water")).toBe("0.1.2");
  });

  it("bounds list pagination when the history contains no eligible releases", async () => {
    harness.responses.set(`${releasesUrl}/latest`, new Error("GitHub returned HTTP 404."));
    const preview = { ...publish("0.2.0"), prerelease: true };
    for (let page = 1; page <= 10; page++) {
      harness.responses.set(listUrl(page), JSON.stringify(Array(6).fill(preview)));
    }
    await expect(checkForForkUpdate()).rejects.toThrow("No signed published");
    expect(harness.fetchText).toHaveBeenCalledTimes(11);
    expect(requestedManifests()).toEqual([]);
  });
});
