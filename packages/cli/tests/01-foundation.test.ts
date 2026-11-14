#!/usr/bin/env npx zx

/**
 * Phase 1: Foundation Tests
 *
 * Tests basic CLI functionality that doesn't require a daemon:
 * - paseo --version outputs version
 * - paseo --help shows commands
 */

import { $ } from "zx";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

$.verbose = false;

console.log("📋 Phase 1: Foundation Tests\n");

// Test 1.1: --version outputs version
console.log("  Testing paseo --version...");
const versionResult = await $`paseo --version`.nothrow();
if (versionResult.exitCode !== 0) {
  console.error("  ❌ paseo --version failed with exit code", versionResult.exitCode);
  console.error("     stderr:", versionResult.stderr);
  process.exit(1);
}
const versionOutput = versionResult.stdout.trim();
if (!versionOutput.match(/\d+\.\d+\.\d+/)) {
  console.error("  ❌ paseo --version output does not contain version number");
  console.error("     output:", versionOutput);
  process.exit(1);
}
console.log("  ✅ paseo --version outputs:", versionOutput);

// Test 1.2: --help shows commands
console.log("  Testing paseo --help...");
const helpResult = await $`paseo --help`.nothrow();
if (helpResult.exitCode !== 0) {
  console.error("  ❌ paseo --help failed with exit code", helpResult.exitCode);
  console.error("     stderr:", helpResult.stderr);
  process.exit(1);
}
const helpOutput = helpResult.stdout;

// Check for expected sections in help output
const expectedTerms = ["agent", "daemon", "Usage", "Options", "Commands"];
const missingTerms = expectedTerms.filter((term) => !helpOutput.includes(term));
if (missingTerms.length > 0) {
  console.error("  ❌ paseo --help missing expected terms:", missingTerms.join(", "));
  console.error("     output:", helpOutput);
  process.exit(1);
}
console.log("  ✅ paseo --help shows commands");

// Exercise the tarball's own relative imports; workspace dependencies stay local.
const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const packedRoot = await mkdtemp(path.join(tmpdir(), "paseo-cli-package-"));
try {
  const packed = await exec(
    "npm",
    [
      "pack",
      "--workspace=@getpaseo/cli",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packedRoot,
    ],
    { cwd: repoRoot, timeout: 30_000 },
  );
  const [manifest] = JSON.parse(packed.stdout) as [{ filename: string; files: { path: string }[] }];
  const files = new Set(manifest.files.map((file) => file.path));
  for (const required of ["bin/paseo", "dist/index.js", "dist/run.js", "dist/cli.js"]) {
    assert(files.has(required), `CLI package is missing ${required}`);
  }
  const compiledFiles = await readdir(path.join(repoRoot, "packages/cli/dist"), {
    recursive: true,
  });
  for (const file of compiledFiles.filter((entry) => entry.endsWith(".js"))) {
    assert(
      files.has("dist/" + file.split(path.sep).join("/")),
      "CLI package is missing runtime module " + file,
    );
  }
  await exec("tar", ["-xf", path.join(packedRoot, manifest.filename), "-C", packedRoot]);
  const installed = path.join(packedRoot, "package");
  const cliPackage = path.join(repoRoot, "packages/cli/package.json");
  const dependencies = JSON.parse(await readFile(cliPackage, "utf8")).dependencies;
  const resolver = createRequire(cliPackage);
  for (const name of Object.keys(dependencies)) {
    const dependency = resolver.resolve
      .paths(name)
      ?.map((directory) => path.join(directory, name))
      .find(existsSync);
    assert(dependency, "Missing installed CLI dependency " + name);
    const target = path.join(installed, "node_modules", name);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(dependency, target, "dir");
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  for (const args of [
    ["--version"],
    ["--help"],
    ["prime"],
    ["daemon", "status", "--json", "--home", path.join(packedRoot, "home")],
  ]) {
    const result = await exec(process.execPath, [path.join(installed, "bin/paseo"), ...args], {
      cwd: packedRoot,
      env,
      timeout: 20_000,
    });
    assert.equal(result.stderr, "");
    assert(result.stdout.trim().length > 0, `Packed CLI produced no output: ${args.join(" ")}`);
  }
  console.log("  ✅ packed CLI starts from its extracted bin and loads offline commands");
} finally {
  await rm(packedRoot, { recursive: true, force: true });
}

console.log("\n✅ Phase 1: Foundation Tests PASSED");
