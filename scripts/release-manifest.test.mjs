import { expectedAssets, releaseAssets } from "../.github/scripts/release-assets.mjs";

// A separately signed inventory must not change bytes consumed by strict schema-3 clients.
import { desktopManifestBytes } from "../.github/scripts/release-manifest.mjs";
import {
  verifyDesktopReleaseBytes,
  latestVerifiedDesktopRelease,
  verifiedDesktopReleaseForTag,
} from "./desktop-release.mjs";
import { createHash, sign } from "node:crypto";
const digest = (algorithm, bytes, encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
function desktopFixture(primaryBytes) {
  return desktopManifestBytes(primaryBytes, {
    windows: {
      platform: "windows",
      arch: "x64",
      kind: "nsis",
      ...describeAsset(names.windowsInstaller, Buffer.from("exe")),
      sha512: digest("sha512", "exe", "base64"),
    },
    linux: ["x64", "arm64"].map((arch) =>
      Object.assign(describeAsset(`paseo-${version}-linux-${arch}-nix.tar`, Buffer.from("tar")), {
        platform: "linux",
        arch,
        kind: "nix-desktop",
        system: arch === "x64" ? "x86_64-linux" : "aarch64-linux",
        outputPath: `/nix/store/${"b".repeat(32)}-paseo-desktop-${version}`,
        outputPaths: [
          `/nix/store/${"a".repeat(32)}-paseo-${version}`,
          `/nix/store/${"b".repeat(32)}-paseo-desktop-${version}`,
        ],
        closureManifest: describeAsset(
          `paseo-${version}-linux-${arch}-nix.json`,
          Buffer.from("{}"),
        ),
      }),
    ),
  });
}
test("signed desktop discovery binds both inventories and preserves old readers", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pin = publicKey.export({ format: "jwk" }).x;
  const signed = (bytes) => Buffer.from(sign(null, bytes, privateKey).toString("base64url"));
  const primary = releaseManifestBytes(release());
  const desktop = desktopFixture(primary);
  const files = new Map([
    [names.manifest, primary],
    [names.signature, signed(primary)],
    [names.desktopManifest, desktop],
    [names.desktopSignature, signed(desktop)],
  ]);
  const discovered = await latestVerifiedDesktopRelease({
    resolveTag: async () => "paseo-v0.2.0",
    publicKey: pin,
    fetchBytes: async (url) => {
      const bytes = files.get(url.split("/").at(-1));
      assert.ok(bytes);
      return bytes;
    },
  });
  assert.equal(discovered.manifest.artifacts.length, 3);
  const fetchFallbackBytes = async (url) => {
    if (url.startsWith("https://api.github.com/"))
      return Buffer.from(
        JSON.stringify([
          { tag_name: "paseo-v9.9.9", draft: false, prerelease: false },
          { tag_name: "paseo-v0.2.0", draft: false, prerelease: false },
        ]),
      );
    return files.get(url.split("/").at(-1));
  };
  const fallback = await latestVerifiedDesktopRelease({
    resolveTag: async () => "paseo-v9.9.9",
    fetchBytes: fetchFallbackBytes,
    publicKey: pin,
  });
  assert.equal(fallback.tag, "paseo-v0.2.0");
  assert.deepEqual(fallback.manifest, discovered.manifest);
  await assert.rejects(
    verifiedDesktopReleaseForTag("paseo-v9.9.9", {
      fetchBytes: async (url) => {
        assert.ok(
          !url.startsWith("https://api.github.com/"),
          "explicit tag lookup must never list fallbacks",
        );
        return files.get(url.split("/").at(-1));
      },
      publicKey: pin,
    }),
    /names another release/,
  );

  assert.equal(
    verifyReleaseManifestBytes(files.get(names.manifest), files.get(names.signature), pin).artifacts
      .length,
    2,
  );
  const verify = (value, primaryBytes = primary) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return verifyDesktopReleaseBytes(bytes, signed(bytes), primaryBytes, signed(primaryBytes), pin);
  };
  const parsed = JSON.parse(desktop);
  for (const mutate of [
    (m) => {
      m.repository = "getpaseo/paseo";
    },
    (m) => {
      m.primaryManifestSha256 = "f".repeat(64);
    },
    (m) => {
      m.artifacts[0].sha512 = "bad";
    },
    (m) => {
      m.artifacts[0].sha256 = "bad";
    },
    (m) => {
      m.artifacts[0].name = "../installer.exe";
    },
    (m) => {
      m.artifacts[0].bytes = 0;
    },
    (m) => {
      m.artifacts[2] = m.artifacts[1];
    },
    (m) => {
      m.artifacts[1].outputPaths.reverse();
    },
    (m) => {
      m.artifacts[1].outputPaths[0] = m.artifacts[1].outputPaths[1];
    },
    (m) => {
      m.artifacts[1].closureManifest.name = names.windowsInstaller;
    },
    (m) => {
      m.artifacts.pop();
    },
  ]) {
    const value = structuredClone(parsed);
    mutate(value);
    assert.throws(() => verify(value));
  }
  const otherPrimary = Buffer.from(
    primary.toString().replace('"a'.concat("a".repeat(39), '"'), '"c'.concat("c".repeat(39), '"')),
  );
  assert.throws(() => verify(parsed, otherPrimary));
  assert.throws(() =>
    verifyDesktopReleaseBytes(
      Buffer.concat([desktop, Buffer.from(" ")]),
      signed(desktop),
      primary,
      signed(primary),
      pin,
    ),
  );
  assert.throws(() =>
    verifyDesktopReleaseBytes(desktop, signed(desktop), primary, signed(primary)),
  );
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReleaseManifests } from "../.github/scripts/release-manifest.mjs";
test("release build entrypoint signs actual Windows/Linux assets and validates union closure", () => {
  const directory = mkdtempSync(join(tmpdir(), "desktop-release-build-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pin = publicKey.export({ format: "jwk" }).x;
  const config = release();
  const write = (name, bytes) => writeFileSync(join(directory, name), bytes);
  const output = (product, hash = "a") => `/nix/store/${hash.repeat(32)}-${product}-${version}`;
  const closure = (system, outputs) =>
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        kind: "paseo-verification-candidate",
        sourceSha: config.sourceSha,
        forkVersion: version,
        system,
        outputPath: outputs.at(-1),
        provenance: "local-ci-build",
        ...(system === "aarch64-darwin" ? {} : { outputPaths: outputs }),
        closure: outputs
          .map((path) => ({
            path,
            narHash: `sha256-${Buffer.alloc(32).toString("base64")}`,
            narSize: 1,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      }),
    );
  try {
    for (const name of Object.values(names))
      if (
        ![names.manifest, names.signature, names.desktopManifest, names.desktopSignature].includes(
          name,
        )
      )
        write(name, "fixture");
    write(names.macClosure, closure("aarch64-darwin", [output("paseo-desktop")]));
    write(
      names.linuxX64Closure,
      closure("x86_64-linux", [output("paseo"), output("paseo-desktop", "b")]),
    );
    write(
      names.linuxArm64Closure,
      closure("aarch64-linux", [output("paseo"), output("paseo-desktop", "b")]),
    );
    buildReleaseManifests(
      directory,
      {
        VERSION: version,
        SOURCE_SHA: config.sourceSha,
        UPSTREAM_BASE: config.upstreamBase,
        MAC_OUTPUT_PATH: output("paseo-desktop"),
        APK_VERSION_CODE: 202000,
        APK_CERT_SHA256: FORK_ANDROID_CERTIFICATE_SHA256,
        PASEO_RELEASE_MANIFEST_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
      },
      pin,
    );
    const read = (name) => readFileSync(join(directory, name));
    const manifest = verifyDesktopReleaseBytes(
      read(names.desktopManifest),
      read(names.desktopSignature),
      read(names.manifest),
      read(names.signature),
      pin,
    );
    assert.equal(
      manifest.artifacts[0].sha512,
      digest("sha512", read(names.windowsInstaller), "base64"),
    );
    assert.equal(
      manifest.artifacts[1].closureManifest.sha256,
      digest("sha256", read(names.linuxX64Closure)),
    );
    assert.equal(
      verifyReleaseManifestBytes(read(names.manifest), read(names.signature), pin).schemaVersion,
      3,
    );
    assert.deepEqual(
      expectedAssets(version, Object.values(names), { deltas: [] }),
      Object.values(names).sort(),
    );
    for (const name of [
      names.manifest,
      names.signature,
      names.desktopManifest,
      names.desktopSignature,
    ])
      rmSync(join(directory, name));
    const broken = JSON.parse(read(names.linuxX64Closure));
    broken.closure = broken.closure.filter((entry) => entry.path === broken.outputPath);
    write(names.linuxX64Closure, JSON.stringify(broken));
    assert.throws(
      () =>
        buildReleaseManifests(
          directory,
          {
            VERSION: version,
            SOURCE_SHA: config.sourceSha,
            UPSTREAM_BASE: config.upstreamBase,
            MAC_OUTPUT_PATH: output("paseo-desktop"),
            APK_VERSION_CODE: 202000,
            APK_CERT_SHA256: FORK_ANDROID_CERTIFICATE_SHA256,
            PASEO_RELEASE_MANIFEST_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
          },
          pin,
        ),
      /Linux union closure omits a signed output/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
