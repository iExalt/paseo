// Fresh-runner smoke for a Linux release closure, run by release.yml before
// publishing. Imports the CLI/daemon and desktop outputs from the release tar
// with only the release key trusted and substituters disabled, checks the CLI,
// then launches the desktop once under xvfb. The launch's builtin-plugin check
// imports the client and server builds from the closure's own desktop tree, so
// the job installs only release-mac-smoke-deps.mjs and builds nothing.
// Usage: node release-linux-smoke.mjs <directory with tar and closure json>
// Env: VERSION, SOURCE_SHA, PLATFORM (linux-x64 or linux-arm64),
// PASEO_DESKTOP_SMOKE_ARTIFACT_DIR, RUNNER_TEMP.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractNixCacheTar,
  localCacheCopyArgs,
  localCacheCopySignaturesArgs,
  validateNixArtifactClosure,
} from "../../scripts/paseo-nix-update.mjs";
import { assertReleaseKeyOnly } from "./release-mac-smoke.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const systems = { "linux-x64": "x86_64-linux", "linux-arm64": "aarch64-linux" };
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 ** 2 });

// Links the client and server builds in the desktop's runtime tree to where
// packaged-app-smoke.js imports them from the checkout.
async function linkClosureBuilds(desktopTree) {
  const links = [
    [
      join(desktopTree, "node_modules/@getpaseo/client"),
      join(root, "node_modules/@getpaseo/client"),
    ],
    [join(desktopTree, "packages/server/dist"), join(root, "packages/server/dist")],
  ];
  for (const file of [
    "node_modules/@getpaseo/client/dist/daemon-client.js",
    "packages/server/dist/server/server/plugins/builtin/index.js",
  ]) {
    assert.ok(existsSync(join(desktopTree, file)), `The desktop tree has no ${file}`);
  }
  // A clean checkout has neither; never replace a developer's builds.
  for (const [target, link] of links) {
    assert.throws(() => lstatSync(link), { code: "ENOENT" }, `${link} already exists`);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  return links;
}

async function main() {
  const [directory] = process.argv.slice(2);
  const { VERSION: version, SOURCE_SHA: sourceSha, PLATFORM: platform } = process.env;
  assert.equal(process.platform, "linux");
  const system = systems[platform];
  assert.ok(system, `Unexpected platform ${platform}`);
  const base = `paseo-${version}-${platform}-nix`;
  const closureBytes = await readFile(join(directory, `${base}.json`));
  const { outputPath: desktop, outputPaths } = JSON.parse(closureBytes.toString("utf8"));
  const closure = validateNixArtifactClosure(
    closureBytes,
    {
      system,
      outputPath: desktop,
      closureManifest: {
        bytes: closureBytes.length,
        sha256: createHash("sha256").update(closureBytes).digest("hex"),
      },
    },
    { sourceSha, version },
  );
  assert.equal(outputPaths.length, 2);
  const [cli] = outputPaths;
  assert.match(
    cli,
    new RegExp(`^/nix/store/[a-z0-9]{32}-paseo-${version.replaceAll(".", "\\.")}$`),
  );
  assert.equal(outputPaths[1], desktop);
  for (const path of outputPaths)
    assert.ok(!existsSync(path), "A fresh runner must not already hold the release outputs");

  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "paseo-release-"));
  const cache = join(scratch, "cache");
  await extractNixCacheTar(join(directory, `${base}.tar`), cache);
  for (const path of outputPaths) {
    run("nix", localCacheCopyArgs(cache, path));
    run("nix", localCacheCopySignaturesArgs(cache, path));
  }
  await rm(cache, { recursive: true, force: true });
  assertReleaseKeyOnly(outputPaths, closure.closure);

  const cliPath = join(cli, "bin/paseo");
  const cliVersion = run(cliPath, ["--version"]).trim();
  assert.ok(cliVersion.split("\n").includes(version), `The CLI reports ${cliVersion}`);
  console.log(`CLI ${cliVersion}`);

  const desktopTree = join(desktop, "share/paseo-desktop");
  const links = await linkClosureBuilds(desktopTree);
  const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
  await mkdir(artifactDir, { recursive: true });
  await appendFile(
    join(artifactDir, "provenance.txt"),
    links.map(([target, link]) => `${link} -> ${target}\n`).join(""),
  );
  const require = createRequire(import.meta.url);
  const { smokePackagedDesktopApp } = require("../../packages/desktop/e2e/packaged-app-smoke.js");
  // Writes its artifacts to PASEO_DESKTOP_SMOKE_ARTIFACT_DIR as well.
  await smokePackagedDesktopApp({
    appPath: desktopTree,
    executablePath: join(desktop, "bin/paseo-desktop"),
    cliPath,
    checkPackagedIdentity: false,
  });
}

await main();
