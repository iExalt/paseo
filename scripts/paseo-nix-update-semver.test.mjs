import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  forkReleaseManifestFixture,
  forkReleaseManifestV3Fixture,
} from "./test-fixtures/fork-release-manifest.ts";
import { FORK_RELEASE_LINEAGE } from "../packages/protocol/src/release-manifest-v2.ts";
import {
  emptyState,
  validateState,
  assertCurrent,
  planTransaction,
  recoverTransaction,
  retainedState,
} from "./paseo-nix-update-state.mjs";
import {
  executeCommand,
  verifyReleaseManifestBytes,
  validateNixClosureManifest,
  validateNixArtifactClosure,
  httpFailure,
  latestVerifiedRelease,
  verifiedReleaseForTag,
  macArtifact,
  releaseDownloadUrl,
  resolveLatestTag,
} from "./paseo-nix-update.mjs";
import {
  INSTALLED_APP,
  bundleProcesses,
  installAppCopy,
  inspectInstalledApp,
  makeWritable,
  markerOutputPath,
  migrateDockTiles,
  planAppInstall,
  rewriteDockPlist,
  staleLaunchServicesBundles,
} from "./paseo-nix-update-macos.mjs";

const legacy = {
  lineage: "legacy-v1",
  generation: 4,
  identity: `${"d".repeat(40)}-200008`,
  outputPath: `/nix/store/${"d".repeat(32)}-paseo-desktop-0.11.0`,
};
function target(version = "0.1.0", generation = null) {
  return {
    lineage: FORK_RELEASE_LINEAGE,
    generation,
    identity: `${"b".repeat(40)}-v${version}`,
    outputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-${version}`,
    version,
  };
}
function migratingState() {
  return { ...emptyState(), current: legacy, legacyRecovery: legacy };
}
const actual = (entry) => entry && { generation: entry.generation, outputPath: entry.outputPath };

test("semver transaction reducer distinguishes source, target, rollback and conflicting profile movement", () => {
  const initial = migratingState();
  const journal = planTransaction(initial, "migrate", target());
  assert.equal(recoverTransaction(journal, actual(legacy)).switched, false);
  const state = recoverTransaction(journal, actual(target("0.1.0", 5))).state;
  assert.equal(state.highWater.version, "0.1.0");
  assert.deepEqual(state.legacyRecovery, legacy);
  assert.throws(() => recoverTransaction(journal, actual(target("0.2.0", 6))), /unexpected output/);
  assert.throws(() => planTransaction(state, "activate", target("0.0.9")), /high-water/);
  const rollback = planTransaction(state, "rollback", legacy);
  const rolledBack = recoverTransaction(rollback, actual(legacy)).state;
  assert.equal(rolledBack.highWater.version, "0.1.0");
  assert.throws(
    () => recoverTransaction(rollback, { ...actual(legacy), generation: 99 }),
    /different retained/,
  );
  const reactivate = planTransaction(rolledBack, "reactivate-high-water", state.highWater);
  assert.deepEqual(recoverTransaction(reactivate, actual(state.highWater)).state, state);
  assert.throws(() => assertCurrent(state, actual(legacy)), /outside the updater/);
  assert.throws(() => validateState({ ...state, highWater: null }), /highest activated/);
  assert.throws(
    () => validateState({ ...state, releaseSequence: 200008 }),
    /Unsupported updater fields/,
  );
});

async function assertSignedReleaseVerification(manifest) {
  const artifact = macArtifact(manifest);
  assert.equal(artifact.system, "aarch64-darwin");
  const closure = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      kind: "paseo-verification-candidate",
      sourceSha: manifest.sourceSha,
      forkVersion: manifest.version,
      system: artifact.system,
      outputPath: artifact.outputPath,
      provenance: "local-ci-build",
      closure: [{ path: artifact.outputPath, narHash: `sha256-${"A".repeat(43)}=`, narSize: 100 }],
    }),
  );
  artifact.closureManifest.bytes = closure.length;
  artifact.closureManifest.sha256 = createHash("sha256").update(closure).digest("hex");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = Buffer.from(sign(null, bytes, keys.privateKey).toString("base64url"));
  assert.deepEqual(verifyReleaseManifestBytes(bytes, signature, publicKey), manifest);
  assert.throws(
    () => verifyReleaseManifestBytes(Buffer.from(JSON.stringify(manifest)), signature, publicKey),
    /signature/,
  );
  const old = Buffer.from(JSON.stringify({ schemaVersion: 1, releaseSequence: 200008 }));
  assert.throws(() =>
    verifyReleaseManifestBytes(
      old,
      Buffer.from(sign(null, old, keys.privateKey).toString("base64url")),
      publicKey,
    ),
  );
  assert.equal(validateNixClosureManifest(closure, manifest).forkVersion, "0.1.0");
  assert.deepEqual(
    validateNixArtifactClosure(closure, artifact, manifest),
    validateNixClosureManifest(closure, manifest),
  );
  assert.throws(() => validateNixClosureManifest(closure, { ...manifest, artifacts: [artifact] }));
  assert.throws(() =>
    validateNixClosureManifest(Buffer.concat([closure, Buffer.from(" ")]), manifest),
  );
  const fetched = [];
  const fetchBytes = async (url) => {
    fetched.push(url);
    return url.endsWith(".sig") ? signature : bytes;
  };
  const latest = await latestVerifiedRelease({
    resolveTag: async () => manifest.releaseTag,
    fetchBytes,
    publicKey,
  });
  assert.equal(latest.tag, manifest.releaseTag);
  assert.deepEqual(latest.manifest, manifest);
  assert.deepEqual(fetched, [
    `https://github.com/iExalt/paseo/releases/download/${manifest.releaseTag}/paseo-release-manifest.json`,
    `https://github.com/iExalt/paseo/releases/download/${manifest.releaseTag}/paseo-release-manifest.sig`,
  ]);
  const fallback = await latestVerifiedRelease({
    resolveTag: async () => "paseo-v9.9.9",
    publicKey,
    fetchBytes: async (url) =>
      url.startsWith("https://api.github.com/")
        ? Buffer.from(
            JSON.stringify([
              { tag_name: "paseo-v9.9.9", draft: false, prerelease: false },
              { tag_name: manifest.releaseTag, draft: false, prerelease: false },
            ]),
          )
        : fetchBytes(url),
  });
  assert.equal(fallback.tag, manifest.releaseTag);
  assert.deepEqual(fallback.manifest, manifest);
  await assert.rejects(
    verifiedReleaseForTag("paseo-v9.9.9", { fetchBytes, publicKey }),
    /names another release/,
  );
}

test("V2 verification binds exact signed bytes and producer closure metadata without accepting V1", () =>
  assertSignedReleaseVerification(forkReleaseManifestFixture()));

test("V3 verification binds the two-cell manifest to the same macOS Nix artifact checks", () =>
  assertSignedReleaseVerification(forkReleaseManifestV3Fixture()));

test("latest release resolves through the non-API redirect and reports rate limits", async () => {
  const redirect =
    (location, status = 302) =>
    async (url, init) => {
      assert.equal(url, "https://github.com/iExalt/paseo/releases/latest");
      assert.equal(init.redirect, "manual");
      return new Response(null, { status, headers: location ? { location } : {} });
    };
  assert.equal(
    await resolveLatestTag(redirect("https://github.com/iExalt/paseo/releases/tag/paseo-v0.1.3")),
    "paseo-v0.1.3",
  );
  for (const location of [
    "https://github.com/iExalt/paseo/releases/tag/v0.1.3",
    "https://github.com/iExalt/paseo/releases/tag/ci-upgrade-fixtures-v0.1.0",
    "https://example.com/iExalt/paseo/releases/tag/paseo-v0.1.3",
    "https://github.com/other/paseo/releases/tag/paseo-v0.1.3",
  ])
    await assert.rejects(resolveLatestTag(redirect(location)), /latest (GitHub )?release/i);
  await assert.rejects(resolveLatestTag(redirect(null, 404)), /HTTP 404 for the latest release/);
  const limited = new Response(null, {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791955320" },
  });
  assert.equal(
    httpFailure("the release list", limited).message,
    "GitHub rate limit reached while fetching the release list. Retry after 2026-10-14T05:22:00.000Z.",
  );
  assert.match(
    httpFailure("x", new Response(null, { status: 429, headers: { "retry-after": "60" } }), 0)
      .message,
    /Retry after 1970-01-01T00:01:00.000Z/,
  );
  assert.equal(
    httpFailure("x", new Response(null, { status: 403 })).message,
    "GitHub returned HTTP 403 for x.",
  );
  assert.throws(() => releaseDownloadUrl("paseo-v0.1.3", "../escape"), /asset name/);
  assert.throws(() => releaseDownloadUrl("v0.1.3", "x.json"), /fork release tag/);
});

test("retention keeps current, high-water and the rollback target only while they coincide", () => {
  const v = (version, generation) => target(version, generation);
  const state = (current, generations, legacyRecovery = null) =>
    validateState({
      ...emptyState(),
      highWater: generations.at(-1),
      current,
      generations,
      legacyRecovery,
    });
  const kept = (value) =>
    [value.legacyRecovery, ...value.generations].filter(Boolean).map((entry) => entry.generation);
  const upgraded = state(v("0.3.0", 7), [v("0.1.0", 5), v("0.2.0", 6), v("0.3.0", 7)], legacy);
  assert.deepEqual(kept(retainedState(upgraded)), [6, 7], "Upgrade keeps previous and current");
  const rolledBack = state(v("0.2.0", 6), [v("0.1.0", 5), v("0.2.0", 6), v("0.3.0", 7)], legacy);
  assert.deepEqual(kept(retainedState(rolledBack)), [6, 7], "Rollback keeps current and the next");
  const migrated = state(v("0.1.0", 5), [v("0.1.0", 5)], legacy);
  assert.deepEqual(retainedState(migrated), migrated, "Migration keeps legacy as its rollback");
  const onLegacy = { ...migrated, current: legacy };
  assert.deepEqual(retainedState(onLegacy), onLegacy);
  assert.deepEqual(retainedState(emptyState()), emptyState());
});

test("LaunchServices cleanup keeps only the bundle the app launches from", () => {
  const output = (hash, version) => `/nix/store/${hash.repeat(32)}-paseo-desktop-${version}`;
  const entry = (path, id) =>
    `path:                       ${path} (0x${id})\nidentifier: sh.paseo.desktop\n`;
  const dump = [
    entry(`${output("a", "0.2.0")}/Applications/Paseo.app`, "1b4c"),
    entry(`${output("d", "0.11.0")}/Applications/Paseo.app`, "18f8"),
    entry(`${output("d", "0.11.0")}/Applications/Paseo.app`, "18f9"),
    entry(
      `${output("d", "0.11.0")}/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app`,
      "18fc",
    ),
    entry(`/nix/store/${"e".repeat(32)}-other-app-1.0/Applications/Paseo.app`, "1900"),
    entry("/Users/me/dev/paseo/release/mac-arm64/Paseo.app", "1738"),
  ].join("");
  assert.deepEqual(
    staleLaunchServicesBundles(dump, `${output("a", "0.2.0")}/Applications/Paseo.app`),
    [`${output("d", "0.11.0")}/Applications/Paseo.app`],
  );
  assert.deepEqual(staleLaunchServicesBundles(dump, INSTALLED_APP), [
    `${output("a", "0.2.0")}/Applications/Paseo.app`,
    `${output("d", "0.11.0")}/Applications/Paseo.app`,
  ]);
});

test("installed app plan replaces only updater-owned apps, and only while none runs", () => {
  const active = `/nix/store/${"a".repeat(32)}-paseo-desktop-0.6.0`;
  const older = `/nix/store/${"b".repeat(32)}-paseo-desktop-0.5.0`;
  const marker = (outputPath) =>
    markerOutputPath(JSON.stringify({ schemaVersion: 1, managedBy: "nix", outputPath }));
  assert.deepEqual(marker(active), { managed: true, outputPath: active });
  assert.deepEqual(marker("/Applications/Paseo.app"), { managed: true, outputPath: null });
  assert.deepEqual(markerOutputPath("{}"), { managed: false, outputPath: null });
  const plan = (installed, { activeMarker = marker(active), busy = false } = {}) =>
    planAppInstall({ installed, activeOutputPath: active, activeMarker, busy }).action;
  const profileLink = {
    kind: "symlink",
    target: "/Users/me/Library/Application Support/Paseo/nix-update/profile/Applications/Paseo.app",
  };
  assert.equal(plan({ kind: "missing" }), "install");
  assert.equal(plan(profileLink), "install");
  assert.equal(plan({ kind: "symlink", target: `${older}/Applications/Paseo.app` }), "install");
  assert.equal(plan({ kind: "directory", ...marker(older) }), "install");
  assert.equal(plan({ kind: "directory", ...marker(active) }), "current");
  assert.equal(plan({ kind: "directory", ...marker(active) }, { busy: true }), "current");
  assert.equal(plan({ kind: "directory", ...marker(older) }, { busy: true }), "defer");
  // A plain Electron install, a foreign link, or a release without outputPath stays put.
  assert.equal(plan({ kind: "directory", managed: false, outputPath: null }), "skip");
  assert.equal(plan({ kind: "symlink", target: "/opt/Paseo.app" }), "skip");
  assert.equal(plan({ kind: "other" }), "skip");
  assert.equal(plan(profileLink, { activeMarker: marker(undefined) }), "skip");
  assert.deepEqual(
    bundleProcesses(
      [
        "  101 /Applications/Paseo.app/Contents/MacOS/Paseo",
        "  102 /Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper --type=gpu",
        "  103 /Applications/Paseo.app.staging/Contents/MacOS/Paseo",
        "  105 /Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper /Users/me/.paseo/terminal-worker/0.21.0-abc/terminal-worker.mjs --paseo-terminal-worker 2b30",
        "  106 /usr/bin/grep --paseo-terminal-worker",
        "  104 /nix/store/x/Applications/Paseo.app/Contents/MacOS/Paseo",
      ].join("\n"),
      INSTALLED_APP,
    ),
    [101, 102],
  );
});

test("installed app copy replaces a profile link, preserves links, and never leaves the path empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-installed-app-"));
  try {
    const source = join(root, "store", "Paseo.app");
    const markerFile = join(source, "Contents", "Resources", "paseo-nix-managed.json");
    await mkdir(dirname(markerFile), { recursive: true });
    const outputPath = `/nix/store/${"a".repeat(32)}-paseo-desktop-0.6.0`;
    await writeFile(markerFile, JSON.stringify({ managedBy: "nix", outputPath }));
    await symlink("Resources", join(source, "Contents", "Current"));
    // Store outputs are read-only; the copy must still be replaceable later.
    for (const path of [markerFile, dirname(markerFile), join(source, "Contents"), source])
      await chmod(path, path === markerFile ? 0o444 : 0o555);
    const applications = join(root, "Applications");
    await mkdir(applications);
    const destination = join(applications, "Paseo.app");
    await symlink(source, destination);
    await mkdir(join(applications, ".Paseo.app.staging-crashed"));

    // ditto exists only on macOS; CI runs this on Linux.
    const portableCopy = (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true });
    await installAppCopy(
      source,
      destination,
      process.platform === "darwin" ? undefined : { copy: portableCopy },
    );
    assert.deepEqual(await inspectInstalledApp(destination), {
      kind: "directory",
      managed: true,
      outputPath,
    });
    assert.ok((await lstat(join(destination, "Contents", "Current"))).isSymbolicLink());
    assert.deepEqual(await readdir(applications), ["Paseo.app"]);

    const installed = await inspectInstalledApp(destination);
    const failingCopies = [
      [async () => Promise.reject(new Error("disk full")), /disk full/],
      // Nothing staged: the swap fails after the old app moved aside, which is restored.
      [async () => {}, /ENOENT/],
    ];
    for (const [copy, error] of failingCopies) {
      await assert.rejects(installAppCopy(source, destination, { copy }), error);
      assert.deepEqual(await inspectInstalledApp(destination), installed);
      assert.deepEqual(await readdir(applications), ["Paseo.app"]);
    }
  } finally {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("command orchestration preserves legacy bytes, retries interrupted migration, and retains high-water across recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-semver-commands-"));
  const files = {
    state: join(root, "state.json"),
    journal: join(root, "journal.json"),
    staged: join(root, "staged.json"),
  };
  const legacyFile = join(root, "legacy-receipt.json");
  const legacyBytes = '{"schemaVersion":1,"releaseSequence":200008}\n';
  await writeFile(legacyFile, legacyBytes);
  const read = async (file) => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  let selected = actual(legacy);
  let failWrite = true;
  let failSelect = true;
  let failClear = false;
  let legacyPending = true;
  let candidateVersion = "0.1.0";
  let latestFailure = null;
  let selections = 0;
  let lastGeneration = 4;
  const synced = [];
  const pruned = [];
  const adapters = {
    current: async () => selected,
    readState: () => read(files.state),
    readJournal: () => read(files.journal),
    writeState: async (state) => {
      if (failWrite) throw new Error("state write interrupted");
      await writeFile(files.state, JSON.stringify(state));
    },
    writeJournal: (journal) => writeFile(files.journal, JSON.stringify(journal)),
    clearJournal: async () => {
      if (failClear) {
        failClear = false;
        throw new Error("journal cleanup interrupted");
      }
      await rm(files.journal, { force: true });
    },
    async verifyTarget(value) {
      assert.ok(value.identity);
    },
    async selectTarget(value) {
      if (failSelect) throw new Error("profile switch interrupted");
      selections++;
      selected = actual({ ...value, generation: value.generation ?? ++lastGeneration });
    },
    async pruneGenerations(keep) {
      pruned.push(keep.join(","));
    },
    async syncDesktopApp(outputPath) {
      synced.push(outputPath.slice(outputPath.lastIndexOf("-") + 1));
    },
    async assertNoLegacyJournal() {
      assert.equal(legacyPending, false, "legacy pending journal");
    },
    legacySnapshot: async () => ({ target: legacy }),
    readStaged: () => read(files.staged),
    clearStaged: () => rm(files.staged, { force: true }),
    loadReceipt: async (value) => {
      assert.ok(value.identity);
    },
    latest: async () => {
      if (latestFailure) throw new Error(latestFailure);
      // 0.1.0 is the last v2 release; 0.1.1 crosses over to the v3 two-cell manifest.
      const fixture =
        candidateVersion === "0.1.0" ? forkReleaseManifestFixture : forkReleaseManifestV3Fixture;
      return { manifest: fixture(candidateVersion) };
    },
    stage: async () => {
      const value = target(candidateVersion);
      await writeFile(files.staged, JSON.stringify(value));
      return value;
    },
  };
  try {
    await assert.rejects(executeCommand("migrate", adapters), /legacy pending/);
    assert.equal(selections, 0);
    legacyPending = false;
    await assert.rejects(executeCommand("check", adapters), /manual migration/);
    await assert.rejects(executeCommand("migrate", adapters), /profile switch interrupted/);
    await assert.rejects(executeCommand("status", adapters), /manual migration/);
    assert.equal(
      await read(files.journal),
      null,
      "Unchanged-source recovery clears only its own journal",
    );
    assert.equal(await read(files.state), null);
    failSelect = false;
    await assert.rejects(executeCommand("migrate", adapters), /state write interrupted/);
    assert.equal(selections, 1);
    assert.equal((await read(files.journal)).action, "migrate");
    failWrite = false;
    failClear = true;
    await assert.rejects(executeCommand("migrate", adapters), /journal cleanup interrupted/);
    assert.equal((await read(files.state)).highWater.version, "0.1.0");
    const migrated = await executeCommand("migrate", adapters);
    assert.equal(migrated.highWaterVersion, "0.1.0");
    assert.equal(selections, 1, "Recovery must not repeat the profile switch");
    assert.equal(await read(files.journal), null);
    assert.equal((await executeCommand("migrate", adapters)).active.version, "0.1.0");
    const rolledBack = await executeCommand("rollback", adapters);
    assert.equal(rolledBack.active, null);
    assert.equal(rolledBack.highWaterVersion, "0.1.0");
    await assert.rejects(executeCommand("stage", adapters), /high-water/);
    assert.equal((await executeCommand("reactivate-high-water", adapters)).active.version, "0.1.0");
    candidateVersion = "0.1.1";
    assert.equal((await executeCommand("stage", adapters)).staged.version, "0.1.1");
    assert.equal(
      (await read(files.state)).highWater.version,
      "0.1.0",
      "Staging must not advance installed state",
    );
    selected = { ...selected, generation: 99 };
    await assert.rejects(executeCommand("activate", adapters), /outside the updater/);
    selected = actual(target("0.1.0", 5));
    const upgraded = await executeCommand("activate", adapters);
    assert.equal(upgraded.active.version, "0.1.1");
    assert.equal(upgraded.highWaterVersion, "0.1.1");
    assert.equal(selected.generation, 6);
    const previousFork = await executeCommand("rollback", adapters);
    assert.equal(previousFork.active.version, "0.1.0");
    assert.equal(previousFork.highWaterVersion, "0.1.1");
    assert.equal(selected.generation, 5);
    const reactivated = await executeCommand("reactivate-high-water", adapters);
    assert.equal(reactivated.active.version, "0.1.1");
    assert.equal(reactivated.highWaterVersion, "0.1.1");
    assert.equal(selected.generation, 6);
    latestFailure = "GitHub rate limit reached while fetching the latest release. Retry later.";
    const offline = await executeCommand("check", adapters);
    assert.equal(offline.active.version, "0.1.1", "A failed lookup keeps local facts");
    assert.equal(offline.latestError, latestFailure);
    assert.equal(offline.canStage, false);
    await assert.rejects(executeCommand("stage", adapters), /rate limit/);
    assert.deepEqual(
      synced,
      ["0.1.0", "0.1.0", "0.11.0", "0.1.0", "0.1.1", "0.1.0", "0.1.1"],
      "Every completed switch or replay registers the active bundle; failures and reads do not",
    );
    assert.deepEqual(
      pruned,
      ["4,5", "4,5", "4,5", "4,5", "5,6", "5,6", "5,6"],
      "Pruning runs with every registration and keeps only the retained generations",
    );
    const finalState = await read(files.state);
    assert.deepEqual(
      finalState.generations.map((entry) => entry.generation),
      [5, 6],
    );
    assert.equal(
      finalState.legacyRecovery,
      null,
      "An upgrade past migration drops legacy recovery",
    );
    assert.equal(await readFile(legacyFile, "utf8"), legacyBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dock migration repoints store-pinned Paseo tiles at the installed app and keeps one", () => {
  const tile = (url, book = "") => `
\t\t<dict>
\t\t\t<key>GUID</key>
\t\t\t<integer>1</integer>
\t\t\t<key>tile-data</key>
\t\t\t<dict>${book ? `\n\t\t\t\t<key>book</key>\n\t\t\t\t<data>\n\t\t\t\t${book}\n\t\t\t\t</data>` : ""}
\t\t\t\t<key>file-data</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>_CFURLString</key>
\t\t\t\t\t<string>${url}</string>
\t\t\t\t\t<key>_CFURLStringType</key>
\t\t\t\t\t<integer>15</integer>
\t\t\t\t</dict>
\t\t\t</dict>
\t\t</dict>`;
  const plist = (...tiles) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>persistent-apps</key>
\t<array>${tiles.join("")}
\t</array>
\t<key>tilesize</key>
\t<real>48</real>
\t<key>wvous-br-corner</key>
\t<true/>
</dict>
</plist>
`;
  const store = (hash, version) =>
    `file:///nix/store/${hash.repeat(32)}-paseo-desktop-${version}/Applications/Paseo.app/`;
  const finder = tile("file:///System/Applications/Mail.app/", "AAAA");
  const installed = "file:///Applications/Paseo.app/";
  const before = plist(
    finder,
    tile(store("m", "0.4.0"), "Ym9vaw=="),
    tile(store("7", "0.3.0")),
    tile(installed),
    tile(
      "file:///Users/me/Library/Application%20Support/Paseo/nix-update/profile/Applications/Paseo.app/",
    ),
    tile("file:///Users/me/dev/paseo/release/mac-arm64/Paseo.app/"),
  );
  const result = rewriteDockPlist(before);
  assert.equal(result.changed, true);
  assert.equal(
    result.xml,
    plist(finder, tile(installed), tile("file:///Users/me/dev/paseo/release/mac-arm64/Paseo.app/")),
  );
  assert.deepEqual(rewriteDockPlist(result.xml), { xml: result.xml, changed: false });
  const untouched = plist(finder, tile(installed));
  assert.deepEqual(rewriteDockPlist(untouched), { xml: untouched, changed: false });

  const calls = [];
  const adapters = (xml) => ({
    exportDock: () => xml,
    importDock: (value) => calls.push(["import", value]),
    restartDock: () => calls.push(["restart"]),
  });
  assert.equal(migrateDockTiles(adapters(untouched)), false);
  assert.deepEqual(calls, []);
  assert.equal(migrateDockTiles(adapters(before)), true);
  assert.deepEqual(calls, [["import", result.xml], ["restart"]]);
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(migrateDockTiles(adapters("<plist><dict>")), false);
  } finally {
    process.stderr.write = stderr;
  }
});

import { execFileSync, spawnSync } from "node:child_process";
import {
  linuxUpdatePaths,
  assertLinuxLauncherOwnership,
  syncLinuxLauncher,
  syncLinuxCli,
  linuxProfileCli,
  validateLinuxNixPrerequisites,
  executeLinuxBootstrap,
} from "./paseo-nix-update-linux.mjs";
import { desktopNixArtifact } from "./paseo-nix-update.mjs";

test("Linux launcher follows only its dedicated profile and preserves foreign files", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo linux home 'quoted "));
  const paths = linuxUpdatePaths({ home, env: {} });
  const profile = join(paths.root, "profile");
  try {
    await syncLinuxLauncher(profile, paths);
    const original = await readFile(paths.launcher, "utf8");
    for (const version of ["one", "two"]) {
      const output = join(home, version);
      await mkdir(join(output, "bin"), { recursive: true });
      await writeFile(join(output, "bin", "paseo-desktop"), `#!/bin/sh\nprintf '${version}\\n'\n`, {
        mode: 0o755,
      });
      await mkdir(paths.root, { recursive: true });
      await rm(profile, { force: true });
      await symlink(output, profile);
      assert.equal(execFileSync(paths.launcher, [], { encoding: "utf8" }).trim(), version);
      await syncLinuxLauncher(profile, paths);
      assert.equal(await readFile(paths.launcher, "utf8"), original);
    }
    await rm(paths.launcher);
    await symlink(join(home, "two", "bin", "paseo-desktop"), paths.launcher);
    await assert.rejects(assertLinuxLauncherOwnership(profile, paths), /externally managed/);
    assert.equal((await lstat(paths.launcher)).isSymbolicLink(), true);
    assert.equal(execFileSync(paths.launcher, [], { encoding: "utf8" }).trim(), "two");
    assert.throws(
      () => linuxUpdatePaths({ home, env: { XDG_STATE_HOME: "relative" } }),
      /absolute/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Linux CLI migration requires exact verified ownership and follows active profile switches", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-cli-profile-"));
  const paths = linuxUpdatePaths({ home, env: {} });
  const profile = join(paths.root, "profile");
  const cli = join(home, ".local/bin/paseo");
  const output = target("0.1.0").outputPath;
  const legacySource = `${output}/share/paseo-desktop/packages/cli/bin/paseo`;
  try {
    await syncLinuxCli(profile, async () => true, paths);
    await assert.rejects(lstat(cli), { code: "ENOENT" });
    await mkdir(dirname(cli), { recursive: true });
    await symlink(legacySource, cli);
    await syncLinuxCli(profile, async () => false, paths);
    assert.equal(await readlink(cli), legacySource);
    await syncLinuxCli(profile, async (candidate) => candidate === output, paths);
    assert.equal(await readlink(cli), linuxProfileCli(profile));
    await mkdir(paths.root, { recursive: true });
    for (const version of ["one", "two"]) {
      const source = join(home, version);
      const entry = linuxProfileCli(source);
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(entry, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o755 });
      await rm(profile, { force: true });
      await symlink(source, profile);
      assert.equal(execFileSync(cli, [], { encoding: "utf8" }).trim(), version);
    }
    await rm(cli);
    await symlink("/foreign/missing/cli", cli);
    await syncLinuxCli(profile, async () => true, paths);
    assert.equal(await readlink(cli), "/foreign/missing/cli");
    await rm(cli);
    await writeFile(cli, "foreign file");
    await syncLinuxCli(profile, async () => true, paths);
    assert.equal(await readFile(cli, "utf8"), "foreign file");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Linux bootstrap command controller verifies running output and ownership before adoption, and retries interruptions", async () => {
  const artifact = {
    platform: "linux",
    arch: "x64",
    kind: "nix-desktop",
    outputPath: target().outputPath,
  };
  const release = { manifest: { schemaVersion: 1, artifacts: [artifact] } };
  const events = [];
  let failStage = true;
  const adapters = {
    runningOutput: target().outputPath,
    artifact: (manifest) => desktopNixArtifact(manifest, "x64"),
    assertOwnership: async () => {
      events.push("ownership");
    },
    preflight: async () => {
      events.push("permissions");
    },
    runningRelease: async () => release,
    prepareLauncher: async () => {
      events.push("launcher");
    },
    stage: async () => {
      events.push("stage");
      if (failStage) throw new Error("interrupted import");
    },
    rollbackLauncher: async () => {
      events.push("undo-launcher");
    },
    activate: async () => {
      events.push("activate");
      return { ok: true };
    },
  };
  await assert.rejects(executeLinuxBootstrap(adapters), /interrupted/);
  assert.equal(events.includes("activate"), false);
  failStage = false;
  events.length = 0;
  assert.deepEqual(await executeLinuxBootstrap(adapters), { ok: true });
  assert.deepEqual(events, ["ownership", "permissions", "stage", "launcher", "activate"]);
  events.length = 0;
  await assert.rejects(
    executeLinuxBootstrap({ ...adapters, runningOutput: target("0.2.0").outputPath }),
    /differs/,
  );
  assert.equal(events.includes("stage"), false);
  await assert.rejects(
    executeLinuxBootstrap({
      ...adapters,
      assertOwnership: async () => {
        throw new Error("foreign profile");
      },
    }),
    /foreign/,
  );
  await assert.rejects(
    executeLinuxBootstrap({
      ...adapters,
      runningRelease: async () => {
        throw new Error("missing signed sidecar");
      },
    }),
    /sidecar/,
  );
  assert.throws(
    () =>
      validateLinuxNixPrerequisites(
        { trusted: false },
        { "trusted-public-keys": { value: [] } },
        "fork-key",
      ),
    /administrator/,
  );
  validateLinuxNixPrerequisites(
    { trusted: false },
    { "trusted-public-keys": { value: ["fork-key"] } },
    "fork-key",
  );
});

test("packaged updater imports its shipped contracts and real CLI fails closed on untrusted Nix", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-packaged-helper-")));
  try {
    const recipe = await readFile(new URL("../nix/desktop-package.nix", import.meta.url), "utf8");
    for (const [prefix, destination] of [
      ["scripts/paseo-nix-update.mjs", "scripts"],
      ["packages/protocol/src/release-manifest.ts", "packages/protocol/src"],
    ]) {
      const start = recipe.indexOf(`cp ${prefix}`);
      const end = recipe.indexOf(`"$updater_root/${destination}/"`, start);
      assert.ok(start >= 0 && end > start);
      const files = recipe
        .slice(start + 3, end)
        .replaceAll("\\", "")
        .trim()
        .split(/\s+/);
      await mkdir(join(directory, destination), { recursive: true });
      for (const file of files)
        await cp(
          new URL(`../${file}`, import.meta.url),
          join(directory, destination, file.split("/").at(-1)),
        );
    }
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const cli = join(directory, "scripts", "paseo-nix-update.mjs");
    const cliArgs = [
      "--import",
      new URL("./test-fixtures/update-platform.mjs", import.meta.url).pathname,
      cli,
    ];
    assert.match(
      execFileSync(process.execPath, [...cliArgs, "--help"], { encoding: "utf8" }),
      /bootstrap/,
    );
    await mkdir(join(directory, "bin"));
    await writeFile(
      join(directory, "bin", "nix"),
      `#!/bin/sh\ncase "$*" in\n *"store info"*) printf '{"trusted":false}' ;;\n *"config show"*) printf '{"trusted-public-keys":{"value":[]}}' ;;\n *) exit 99 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [...cliArgs, "bootstrap", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: directory,
        XDG_STATE_HOME: join(directory, "state"),
        XDG_DATA_HOME: join(directory, "data"),
        PASEO_NIX_OUTPUT_PATH: target().outputPath,
        PATH: `${join(directory, "bin")}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(JSON.parse(result.stdout).error, /must trust the Paseo release key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { desktopManifestBytes, describeAsset } from "../.github/scripts/release-manifest.mjs";
import { releaseAssets } from "../.github/scripts/release-assets.mjs";
test("real Linux CLI verifies dual receipts, imports both roots, recovers interrupted selection and prunes only obsolete roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-linux-rehearsal-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pin = publicKey.export({ format: "jwk" }).x;
  const signature = (bytes) => Buffer.from(sign(null, bytes, privateKey).toString("base64url"));
  const roots = {};
  const macRoots = {};
  const output = (version, product) => `/nix/store/${"a".repeat(32)}-${product}-${version}`;
  const signedStateRoot = join(directory, "state", "paseo", "nix-update");
  const nixStateFile = join(directory, "nix-state.json");
  try {
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      const names = releaseAssets(version),
        destination = join(directory, "releases", version);
      await mkdir(destination, { recursive: true });
      const primary = forkReleaseManifestV3Fixture(version);
      let primaryBytes;
      const archive = Buffer.from(`fixture signed union archive ${version}`);
      const outputs = [output(version, "paseo"), output(version, "paseo-desktop")];
      const closure = outputs.map((path) => ({
        path,
        narHash: `sha256-${Buffer.alloc(32).toString("base64")}`,
        narSize: 1,
      }));
      for (const value of outputs) roots[value] = closure;
      macRoots[outputs[1]] = [closure[1]];
      const macClosure = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          kind: "paseo-verification-candidate",
          sourceSha: primary.sourceSha,
          forkVersion: version,
          system: "aarch64-darwin",
          outputPath: outputs[1],
          provenance: "local-ci-build",
          closure: [closure[1]],
        }),
      );
      await writeFile(join(destination, names.macArchive), archive);
      await writeFile(join(destination, names.macClosure), macClosure);
      Object.assign(
        primary.artifacts.find((entry) => entry.platform === "macos"),
        describeAsset(names.macArchive, archive),
        { outputPath: outputs[1], closureManifest: describeAsset(names.macClosure, macClosure) },
      );
      primaryBytes = Buffer.from(JSON.stringify(primary));

      const linux = [];
      for (const arch of ["x64", "arm64"]) {
        const prefix = `paseo-${version}-linux-${arch}-nix`;
        const system = arch === "x64" ? "x86_64-linux" : "aarch64-linux";
        const closureBytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 2,
            kind: "paseo-verification-candidate",
            sourceSha: primary.sourceSha,
            forkVersion: version,
            system,
            outputPath: outputs[1],
            outputPaths: outputs,
            provenance: "local-ci-build",
            closure,
          }),
        );
        await writeFile(join(destination, `${prefix}.tar`), archive);
        await writeFile(join(destination, `${prefix}.json`), closureBytes);
        linux.push(
          Object.assign(describeAsset(`${prefix}.tar`, archive), {
            platform: "linux",
            arch,
            kind: "nix-desktop",
            system,
            outputPath: outputs[1],
            outputPaths: outputs,
            closureManifest: describeAsset(`${prefix}.json`, closureBytes),
          }),
        );
      }
      const installer = Buffer.from("fixture installer");
      const desktop = desktopManifestBytes(primaryBytes, {
        linux,
        windows: {
          platform: "windows",
          arch: "x64",
          kind: "nsis",
          ...describeAsset(names.windowsInstaller, installer),
          sha512: createHash("sha512").update(installer).digest("base64"),
        },
      });
      for (const [name, bytes] of [
        [names.manifest, primaryBytes],
        [names.signature, signature(primaryBytes)],
        [names.desktopManifest, desktop],
        [names.desktopSignature, signature(desktop)],
      ])
        await writeFile(join(destination, name), bytes);
    }
    await writeFile(join(directory, "closures.json"), JSON.stringify(roots));
    await writeFile(join(directory, "mac-closures.json"), JSON.stringify(macRoots));
    await writeFile(nixStateFile, JSON.stringify({ profiles: {}, imported: [], calls: [] }));
    const env = {
      ...process.env,
      HOME: directory,
      XDG_STATE_HOME: join(directory, "state"),
      XDG_DATA_HOME: join(directory, "data"),
      PASEO_UPDATE_FIXTURE: directory,
      PASEO_UPDATE_FIXTURE_PIN: pin,
      PASEO_NIX_OUTPUT_PATH: output("0.1.0", "paseo-desktop"),
      PASEO_UPDATE_LATEST: "0.1.0",
    };
    const run = (command, additions = {}) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          new URL("./test-fixtures/linux-update-hooks.mjs", import.meta.url).pathname,
          new URL("./paseo-nix-update.mjs", import.meta.url).pathname,
          command,
          "--json",
        ],
        { env: { ...env, PASEO_UPDATE_FAIL: "", ...additions }, encoding: "utf8", timeout: 15_000 },
      );
    const result = (command, additions) => {
      const child = run(command, additions);
      assert.equal(child.status, 0, `${command}: ${child.stdout}\n${child.stderr}`);
      return JSON.parse(child.stdout);
    };
    let failed = run("bootstrap", { PASEO_UPDATE_FAIL: "import" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /interrupted import/);
    const paths = linuxUpdatePaths({ home: directory, env });
    await assert.rejects(lstat(paths.desktop), { code: "ENOENT" });
    failed = run("bootstrap", { PASEO_UPDATE_FAIL: "select-before" });
    assert.equal(failed.status, 1, failed.stdout);
    await assert.rejects(lstat(paths.desktop), { code: "ENOENT" });
    failed = run("bootstrap", { PASEO_UPDATE_FAIL: "select-after" });
    assert.equal(failed.status, 73, failed.stdout);
    assert.ok(await lstat(join(signedStateRoot, "semver-v1", "pending-activation.json")));
    assert.match(run("bootstrap").stdout, /stale lock/);
    // The fixture owns the exited subprocess; production requires this explicit stale-lock recovery too.
    await rm(join(signedStateRoot, "operation.lock"));
    assert.equal(result("bootstrap").active.version, "0.1.0");
    assert.equal(result("status").highWaterVersion, "0.1.0");
    for (const version of ["0.2.0", "0.3.0"]) {
      assert.equal(result("stage", { PASEO_UPDATE_LATEST: version }).staged.version, version);
      assert.equal(result("activate").active.version, version);
    }
    const state = JSON.parse(await readFile(nixStateFile, "utf8"));
    for (const version of ["0.1.0", "0.2.0", "0.3.0"])
      for (const product of ["paseo", "paseo-desktop"])
        assert.ok(state.imported.includes(output(version, product)));
    assert.ok(
      state.calls.some(
        (args) =>
          args[0] === "store" &&
          args[1] === "verify" &&
          args.filter((value) => value.startsWith("/nix/store/")).length === 2,
      ),
    );
    const receipt = (version) =>
      join(signedStateRoot, "semver-v1", "receipts", `${"b".repeat(40)}-v${version}`);
    for (const version of ["0.2.0", "0.3.0"]) {
      assert.ok((await lstat(join(receipt(version), "cli-profile"))).isSymbolicLink());
      assert.ok(await readFile(join(receipt(version), "primary-manifest.sig")));
    }
    await assert.rejects(lstat(join(receipt("0.1.0"), "cli-profile")), { code: "ENOENT" });
    const installedCli = join(directory, ".local/bin/paseo");
    await symlink(
      `${output("0.1.0", "paseo-desktop")}/share/paseo-desktop/packages/cli/bin/paseo`,
      installedCli,
    );
    assert.equal(result("stage", { PASEO_UPDATE_LATEST: "0.4.0" }).staged.version, "0.4.0");
    failed = run("rollback", { PASEO_UPDATE_FAIL: "verify" });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stdout, /fixture verification refused/);
    assert.equal(result("status").staged.version, "0.4.0");
    failed = run("rollback", { PASEO_UPDATE_FAIL: "select-before" });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stdout, /fixture recovery refused/);
    assert.equal(result("status").staged.version, "0.4.0");
    failed = run("rollback", { PASEO_UPDATE_FAIL: "select-after" });
    assert.equal(failed.status, 73, failed.stdout);
    await rm(join(signedStateRoot, "operation.lock"));
    const rolledBack = result("rollback");
    assert.equal(rolledBack.active.version, "0.2.0");
    assert.equal(rolledBack.highWaterVersion, "0.3.0");
    assert.equal(rolledBack.staged, null);
    assert.equal(await readlink(installedCli), linuxProfileCli(join(signedStateRoot, "profile")));
    await rm(installedCli);
    await symlink("/foreign/missing/cli", installedCli);
    assert.equal(result("stage", { PASEO_UPDATE_LATEST: "0.4.0" }).staged.version, "0.4.0");
    const reactivated = result("reactivate-high-water");
    assert.equal(reactivated.active.version, "0.3.0");
    assert.equal(reactivated.highWaterVersion, "0.3.0");
    assert.equal(reactivated.staged, null);
    assert.equal(await readlink(installedCli), "/foreign/missing/cli");
    await rm(installedCli);
    const legacyCli = `${output("0.1.0", "paseo-desktop")}/share/paseo-desktop/packages/cli/bin/paseo`;
    await symlink(legacyCli, installedCli);
    await writeFile(join(receipt("0.1.0"), "primary-manifest.sig"), "A".repeat(86));
    assert.equal(result("reactivate-high-water").active.version, "0.3.0");
    assert.equal(await readlink(installedCli), legacyCli);
    // The same real retained-generation selector also serves existing schema-3 Mac receipts.
    const macEnv = { PASEO_UPDATE_MAC: "1", PASEO_UPDATE_LATEST: "0.1.0" };
    result("stage", macEnv);
    assert.equal(result("activate", macEnv).active.version, "0.1.0");
    result("stage", { ...macEnv, PASEO_UPDATE_LATEST: "0.2.0" });
    assert.equal(result("activate", macEnv).active.version, "0.2.0");
    assert.equal(result("rollback", macEnv).active.version, "0.1.0");
    assert.equal(result("reactivate-high-water", macEnv).active.version, "0.2.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
