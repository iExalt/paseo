import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { validateManifest, digest } from "../../packages/desktop/e2e/linux-installed-layout.cjs";

const [operation, ...args] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
if (operation === "manifest") {
  const root = realpathSync(args[0]);
  const manifest = {
    schema: 1,
    architecture: process.arch,
    previous: JSON.parse(readFileSync(join(root, "previous.json"))),
    candidate: JSON.parse(readFileSync(join(root, "candidate.json"))),
  };
  validateManifest(
    manifest,
    process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
    process.arch,
  );
  const bytes = JSON.stringify(manifest, null, 2);
  writeFileSync(join(root, "manifest.json"), bytes);
  writeFileSync(join(root, "evidence/manifest.json"), bytes);
} else if (operation === "artifact" || operation === "package") {
  const [manifestFile, stage, format, packages] = args;
  assert.ok(["previous", "candidate"].includes(stage));
  assert.ok(["deb", "rpm", "appimage"].includes(format));
  const manifest = JSON.parse(readFileSync(manifestFile));
  validateManifest(
    manifest,
    process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
    process.arch,
  );
  const artifact = manifest[stage].artifacts[format];
  if (operation === "artifact") {
    const filename = join(realpathSync(packages), artifact.file);
    assert.equal(digest(filename), artifact.sha256);
    console.log(filename);
  } else {
    assert.ok(format !== "appimage");
    console.log(artifact.packageName);
  }
} else {
  assert.ok(["previous", "candidate"].includes(operation));
  const [format, manifestFile, stateRoot, artifactDir, stableFile] = args;
  assert.ok(["deb", "rpm", "appimage"].includes(format));
  const bytes = readFileSync(manifestFile);
  const manifest = JSON.parse(bytes);
  const { smokeInstalledLinuxStage } =
    await import("../../packages/desktop/e2e/packaged-app-smoke.js");
  await smokeInstalledLinuxStage({
    expectedSourceSha: process.env.PASEO_CANDIDATE_SHA || process.env.GITHUB_SHA,
    manifest,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    format,
    stage: operation,
    root: realpathSync(stateRoot),
    artifactDir: resolve(artifactDir),
    stableFile: stableFile && resolve(stableFile),
  });
}
