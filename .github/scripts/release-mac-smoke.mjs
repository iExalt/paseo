// Fresh-runner smoke for the macOS release closure, run by release.yml before
// publishing. It installs the exported cache the way the in-app updater
// stages a release (client tar extractor, only the release key trusted,
// substituters disabled), then checks the bundle signature, the bundled CLI and
// updater, and launches the packaged app once.
// Usage: node release-mac-smoke.mjs <directory with tar and closure json>
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
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

  const cache = join(await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-release-")), "cache");
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

  const require = createRequire(import.meta.url);
  const { smokePackagedDesktopApp } = require("../../packages/desktop/e2e/packaged-app-smoke.js");
  await smokePackagedDesktopApp({
    appPath: app,
    artifactDir: process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR,
  });
}

await main();
