// Fresh-runner smoke for the macOS release closure, run by release.yml before
// publishing. It installs the exported cache the way the in-app updater
// stages a release (client tar extractor, only the release key trusted,
// substituters disabled), then checks the bundle signature, the bundled CLI and
// updater, and launches the packaged app once. The launch's builtin-plugin check
// imports the client and server builds; they come from the closure's own app.asar,
// so the job installs only release-mac-smoke-deps.mjs and builds nothing.
// Usage: node release-mac-smoke.mjs <directory with tar and closure json>
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractNixCacheTar,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  NIX_RELEASE_PUBLIC_KEY,
  validateNixArtifactClosure,
} from "../../scripts/paseo-nix-update.mjs";

const trustOnlyRelease = [
  "--option",
  "builders",
  "",
  "--option",
  "substituters",
  "",
  "--option",
  "require-sigs",
  "true",
  "--option",
  "trusted-public-keys",
  NIX_RELEASE_PUBLIC_KEY,
];
const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 ** 2 });

// The bundle must keep the signature the build applied through NAR packing and
// substitution; macOS refuses notifications from a bundle signed as Electron.
function assertPaseoSignature(app) {
  const codesign = (args) => {
    const result = spawnSync("/usr/bin/codesign", [...args, app], { encoding: "utf8" });
    assert.equal(result.status, 0, `codesign ${args[0]} failed: ${result.stderr}`);
    return result.stderr;
  };
  codesign(["--verify", "--deep", "--strict"]);
  assert.match(codesign(["--display", "--verbose=2"]), /^Identifier=sh\.paseo\.desktop$/m);
}

// Links the client and server builds packed in app.asar to where
// packaged-app-smoke.js imports them from the checkout.
export async function linkClosureBuilds(app, repoRoot, scratch) {
  const { extractAll } = await import("@electron/asar");
  const archive = join(app, "Contents/Resources/app.asar");
  const extracted = join(scratch, "app");
  const links = [
    [
      join(extracted, "node_modules/@getpaseo/client"),
      join(repoRoot, "node_modules/@getpaseo/client"),
    ],
    [join(extracted, "node_modules/@getpaseo/server/dist"), join(repoRoot, "packages/server/dist")],
  ];
  // A clean checkout has neither; never replace a developer's builds.
  for (const [, link] of links) {
    assert.throws(() => lstatSync(link), { code: "ENOENT" }, `${link} already exists`);
  }
  try {
    extractAll(archive, extracted);
  } catch (error) {
    // The asar header still lists unpacked prebuilds the closure omits (other
    // platforms' node-pty, the agent SDK binary); only those may be missing.
    const failures = [...String(error.message).matchAll(/^Error: (.*)$/gm)].map(([, line]) => line);
    const expected = `ENOENT: no such file or directory, open '${archive}.unpacked/`;
    if (!failures.length || failures.some((line) => !line.startsWith(expected))) throw error;
    console.log(
      `Extracted app.asar; ${failures.length} listed unpacked files are not in the closure`,
    );
  }
  for (const [target, link] of links) {
    assert.ok(existsSync(target), `app.asar has no ${target.slice(extracted.length + 1)}`);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  return links;
}

async function main() {
  const [directory] = process.argv.slice(2);
  const { VERSION: version, SOURCE_SHA: sourceSha, OUTPUT_PATH: outputPath } = process.env;
  assert.equal(process.platform, "darwin");
  const base = `paseo-${version}-macos-arm64-nix-desktop`;
  const closureBytes = await readFile(join(directory, `${base}.json`));
  const closure = validateNixArtifactClosure(
    closureBytes,
    {
      system: "aarch64-darwin",
      outputPath,
      closureManifest: {
        bytes: closureBytes.length,
        sha256: createHash("sha256").update(closureBytes).digest("hex"),
      },
    },
    { sourceSha, version },
  );
  assert.ok(!existsSync(outputPath), "A fresh runner must not already hold the release output");

  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-release-"));
  const cache = join(scratch, "cache");
  await extractNixCacheTar(join(directory, `${base}.tar`), cache);
  run("nix", localCacheCopyArgs(cache, outputPath));
  run("nix", localCacheCopySignaturesArgs(cache, outputPath));
  // A daemon that ignores client trust options would fall back to its own keys,
  // so first prove the options bind: another key must not verify the closure.
  const verify = (trusted) =>
    spawnSync(
      "nix",
      [
        "store",
        "verify",
        "--recursive",
        "--sigs-needed",
        "1",
        ...trustOnlyRelease.slice(0, -1),
        trusted,
        outputPath,
      ],
      { encoding: "utf8", timeout: 600_000 },
    );
  const secret = run("nix", ["key", "generate-secret", "--key-name", "paseo-negative-control"]);
  const other = execFileSync("nix", ["key", "convert-secret-to-public"], {
    input: secret,
    encoding: "utf8",
  }).trim();
  const control = verify(other);
  assert.notEqual(control.status, 0, "The closure verified under an unrelated key");
  assert.match(control.stderr, /lacks a signature|untrusted|signature/i, control.stderr);
  const real = verify(NIX_RELEASE_PUBLIC_KEY);
  assert.equal(real.status, 0, `Release key verification failed: ${real.stderr}`);
  for (const result of [control, real])
    assert.doesNotMatch(result.stderr, /ignoring the client-specified setting/);
  const imported = Object.entries(
    JSON.parse(run("nix", ["path-info", "--json", "--recursive", ...trustOnlyRelease, outputPath])),
  )
    .map(([path, info]) => ({ path, narHash: info.narHash, narSize: info.narSize }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepEqual(imported, closure.closure, "Imported closure differs from its manifest");
  console.log(`Imported ${imported.length} signed store paths with only the release key`);

  const app = join(outputPath, "Applications", "Paseo.app");
  assertPaseoSignature(app);
  const cliVersion = run(join(app, "Contents/Resources/bin/paseo"), ["--version"]).trim();
  assert.ok(cliVersion.split("\n").includes(version), `Bundled CLI reports ${cliVersion}`);
  assert.match(
    run(join(outputPath, "bin/paseo-nix-update"), ["--help"]),
    /^Usage: paseo-nix-update/,
  );
  console.log(`Bundle signed as sh.paseo.desktop; bundled CLI ${cliVersion}; updater runs`);

  const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
  const links = await linkClosureBuilds(app, root, scratch);
  await mkdir(artifactDir, { recursive: true });
  await appendFile(
    join(artifactDir, "provenance.txt"),
    links.map(([target, link]) => `${link} -> ${target} (from ${outputPath} app.asar)\n`).join(""),
  );
  const require = createRequire(import.meta.url);
  const { smokePackagedDesktopApp } = require("../../packages/desktop/e2e/packaged-app-smoke.js");
  await smokePackagedDesktopApp({
    appPath: app,
    artifactDir,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
