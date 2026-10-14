import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadStream } from "node:fs";
import { descriptorDigest } from "./candidate-descriptor.mjs";
import { fileIdentity, withVerifiedFile } from "./candidate-files.mjs";
import {
  NIX_RELEASE_PUBLIC_KEY,
  extractNixCacheTar,
} from "../../scripts/paseo-nix-update-legacy.mjs";

const storePath = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/;
const options = [
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
const command = (program, args, extra = {}) =>
  execFileSync(program, args, {
    encoding: "utf8",
    timeout: 480_000,
    maxBuffer: 32 * 1024 ** 2,
    ...extra,
  }).trim();

// Single-threaded xz left the desktop copy within seconds of its 300 s limit;
// parallel xz keeps the same signed .nar.xz format that installers import.
export function signedCacheUrl(cache, key) {
  assert.match(key, /^\/[^?&#%]+$/);
  return `${pathToFileURL(cache).href}?secret-key=${key}&parallel-compression=true`;
}

export function closureEntries(info, output) {
  assert.match(output, storePath);
  const entries = Object.entries(info)
    .map(([path, value]) => {
      assert.match(path, storePath);
      assert.match(value.narHash, /^sha256-[A-Za-z0-9+/]{43}=$/);
      assert.ok(Number.isSafeInteger(value.narSize) && value.narSize > 0);
      return { path, narHash: value.narHash, narSize: value.narSize };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(entries.some(({ path }) => path === output));
  return entries;
}

async function identity(file) {
  let bytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  const result = { bytes, sha256: hash.digest("hex") };
  fileIdentity(result);
  return result;
}

// The native runtime has already passed. This step signs exactly those output
// paths, then imports only the exported bytes into an empty independent store.
// A completed-job controller receipt, not this metadata, attests runtime success.
export async function exportNix(env) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, env.EXPECTED_ARCHITECTURE);
  const context = JSON.parse(await readFile(env.PASEO_CANDIDATE_CONTEXT, "utf8"));
  const { descriptor, runId, attempt } = context;
  assert.equal(runId, Number(env.GITHUB_RUN_ID));
  assert.equal(attempt, Number(env.GITHUB_RUN_ATTEMPT));
  assert.equal(descriptor.sourceSha, env.PASEO_CANDIDATE_SHA);
  assert.equal(descriptorDigest(descriptor), env.CANDIDATE_DESCRIPTOR_DIGEST);
  assert.equal(command("git", ["rev-parse", "HEAD"]), descriptor.sourceSha);
  const arch = env.EXPECTED_ARCHITECTURE;
  assert.ok(["x64", "arm64"].includes(arch));
  const system = arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  const runtime = JSON.parse(
    await readFile(".dev/github-workflows/linux-nix/identity.json", "utf8"),
  );
  assert.equal(runtime.sourceSha, descriptor.sourceSha);
  assert.equal(runtime.version, descriptor.version);
  assert.equal(runtime.architecture, arch);
  const directory = join(env.RUNNER_TEMP, `candidate-nix-${runId}-${attempt}`);
  await mkdir(directory, { mode: 0o700 });
  const exported = join(directory, "export");
  await mkdir(exported);
  const key = join(directory, "signing-key");
  assert.ok(env.NIX_RELEASE_SIGNING_KEY);
  await writeFile(key, env.NIX_RELEASE_SIGNING_KEY + "\n", { mode: 0o600, flag: "wx" });
  delete env.NIX_RELEASE_SIGNING_KEY;
  const artifacts = [];
  try {
    assert.equal(
      command("nix", ["key", "convert-secret-to-public"], { input: await readFile(key) }),
      NIX_RELEASE_PUBLIC_KEY,
    );
    for (const product of ["daemon", "desktop"]) {
      const outputPath = (
        await readFile(join(env.RUNNER_TEMP, `linux-nix-${product}-path`), "utf8")
      ).trim();
      assert.equal(runtime[product], outputPath);
      assert.match(outputPath, storePath);
      const kind = `nix-${product}`;
      const name = `paseo-${descriptor.version}-linux-${arch}-${kind}.tar`;
      const manifestName = name.replace(/\.tar$/, ".json");
      const closure = closureEntries(
        JSON.parse(command("nix", ["path-info", "--json", "--recursive", outputPath])),
        outputPath,
      );
      const manifest = {
        schemaVersion: 1,
        kind: "paseo-nix-closure",
        sourceSha: descriptor.sourceSha,
        treeSha: descriptor.treeSha,
        version: descriptor.version,
        system,
        product,
        outputPath,
        closure,
      };
      const manifestFile = join(exported, manifestName);
      await writeFile(manifestFile, JSON.stringify(manifest) + "\n", { flag: "wx" });
      const manifestPath = command("nix", [
        "store",
        "add",
        "--mode",
        "flat",
        "--name",
        manifestName,
        manifestFile,
      ]);
      assert.match(manifestPath, storePath);
      const cache = join(directory, `${product}-cache`);
      await mkdir(cache);
      command("nix", ["store", "sign", "--key-file", key, "--recursive", outputPath, manifestPath]);
      command("nix", [
        "copy",
        "--to",
        signedCacheUrl(cache, key),
        "--option",
        "builders",
        "",
        outputPath,
        manifestPath,
      ]);
      const archive = join(exported, name);
      command("tar", ["--format=ustar", "-cf", archive, "-C", cache, "."]);
      artifacts.push({
        platform: "linux",
        arch,
        kind,
        name,
        ...(await identity(archive)),
        system,
        outputPath,
        manifestPath,
        closureManifest: { name: manifestName, ...(await identity(manifestFile)) },
      });
      await rm(cache, { recursive: true });
    }
  } finally {
    await rm(key, { force: true });
  }
  // Key is gone before verification; neither the host store nor a remote cache
  // can satisfy an import. Each product gets its own initially nonexistent root.
  for (const artifact of artifacts) {
    const archive = join(exported, artifact.name);
    const manifestFile = join(exported, artifact.closureManifest.name);
    await withVerifiedFile(archive, artifact, async (body) => {
      for await (const _chunk of body) {
        /* verify complete bytes */
      }
    });
    await withVerifiedFile(manifestFile, artifact.closureManifest, async (body) => {
      for await (const _chunk of body) {
        /* verify complete bytes */
      }
    });
    const cache = join(directory, `${artifact.kind}-import-cache`);
    await extractNixCacheTar(archive, cache);
    const isolation = join(directory, `${artifact.kind}-isolation`);
    await mkdir(isolation); // Exclusive new parent guarantees no previous DB/store.
    const destination = `local?root=${isolation}/root&state=${isolation}/state&require-sigs=true`;
    try {
      const roots = [artifact.outputPath, artifact.manifestPath];
      command("nix", [
        "copy",
        "--from",
        pathToFileURL(cache).href,
        "--to",
        destination,
        ...options,
        ...roots,
      ]);
      command("nix", [
        "store",
        "copy-sigs",
        "--store",
        destination,
        "--substituter",
        pathToFileURL(cache).href,
        "--recursive",
        ...options,
        ...roots,
      ]);
      command("nix", [
        "store",
        "verify",
        "--store",
        destination,
        "--recursive",
        "--sigs-needed",
        "1",
        ...options,
        ...roots,
      ]);
      const imported = closureEntries(
        JSON.parse(
          command("nix", [
            "path-info",
            "--store",
            destination,
            "--json",
            "--recursive",
            ...options,
            artifact.outputPath,
          ]),
        ),
        artifact.outputPath,
      );
      const manifestBytes = await readFile(manifestFile, "utf8");
      assert.deepEqual(imported, JSON.parse(manifestBytes).closure);
      // execFileSync's raw output preserves the exact JSON trailing newline.
      const stored = execFileSync(
        "nix",
        ["store", "cat", "--store", destination, ...options, artifact.manifestPath],
        { timeout: 30_000, maxBuffer: 1024 ** 2 },
      );
      assert.deepEqual(stored, Buffer.from(manifestBytes));
    } finally {
      command("chmod", ["-R", "u+w", isolation]);
      await rm(isolation, { recursive: true, force: true });
      await rm(cache, { recursive: true, force: true });
    }
  }
  await writeFile(
    join(exported, "candidate-nix.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "paseo-candidate-nix",
      descriptorSha256: descriptorDigest(descriptor),
      sourceSha: descriptor.sourceSha,
      treeSha: descriptor.treeSha,
      version: descriptor.version,
      runId,
      attempt,
      group: `linux-nix-${arch}`,
      artifacts,
    }) + "\n",
    { flag: "wx" },
  );
  await appendFile(env.GITHUB_OUTPUT, `directory=${exported}\n`);
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    "### Linux Nix signed transport\nBoth native outputs were signed recursively, exported, and verified from exact archive bytes in separate empty isolated stores with no builders/substituters and only the pinned release key. This is isolated-store import proof, not fresh-runner runtime proof.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await exportNix(process.env);
