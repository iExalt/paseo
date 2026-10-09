#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PASEO_RELEASE_MANIFEST_KEY_ID,
  PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
  validatePaseoReleaseManifest,
} from "../packages/protocol/src/release-manifest.ts";

export const REPOSITORY = "iExalt/paseo";
export const NIX_RELEASE_PUBLIC_KEY =
  "paseo-nix-release-1:hOc4RkmgnDMh/+aZWDdwQKuZHDVvVPh0Fya+DNAA+b8=";
export const RELEASE_MANIFEST_ASSET = "paseo-release-manifest.json";
export const RELEASE_SIGNATURE_ASSET = "paseo-release-manifest.sig";
export const DATA_ROOT = join(homedir(), "Library", "Application Support", "Paseo", "nix-update");
export const ACTIVE_PROFILE = join(DATA_ROOT, "profile");
export const STAGING_PROFILE = join(DATA_ROOT, "staging-profile");

const GITHUB_API = "https://api.github.com";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
const REDIRECT_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const PUBLIC_KEY_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

class InvalidReleaseError extends Error {}

function invalidRelease(message) {
  throw new InvalidReleaseError(message);
}

function assertMacArm() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("The managed Nix installer supports only Apple Silicon macOS (aarch64-darwin).");
  }
}

function parseSignature(signatureBytes) {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(signatureBytes).trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) {
    fail("The detached release manifest signature is malformed.");
  }
  return Buffer.from(value, "base64url");
}

export function verifyReleaseManifestBytes(
  manifestBytes,
  signatureBytes,
  publicKeyBase64url = PASEO_RELEASE_MANIFEST_PUBLIC_KEY_BASE64URL,
) {
  const rawPublicKey = Buffer.from(publicKeyBase64url, "base64url");
  const publicKey = createPublicKey({
    key: Buffer.concat([PUBLIC_KEY_SPKI_PREFIX, rawPublicKey]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(null, manifestBytes, publicKey, parseSignature(signatureBytes))) {
    fail("Release manifest signature does not match the independently pinned public key.");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    validatePaseoReleaseManifest(manifest);
  } catch (error) {
    fail(`Release manifest is invalid: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  return manifest;
}

export async function withOperationLock(lockPath, operation) {
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        `Another Paseo updater command is running, or a stale lock remains at ${lockPath}. Confirm no updater is running before removing a stale lock.`,
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

function isStableForkRelease(release) {
  return (
    !release.draft &&
    !release.prerelease &&
    typeof release.tag_name === "string" &&
    /^paseo-fork-v\d+\.\d+\.\d+-r[1-9][0-9]*-[a-f0-9]{40}$/.test(release.tag_name)
  );
}

function sequenceFromTag(tag) {
  const match = tag.match(/-r([1-9][0-9]*)-[a-f0-9]{40}$/);
  return match ? BigInt(match[1]) : 0n;
}

async function fetchHttps(url, headers = {}) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (
      current.protocol !== "https:" ||
      !REDIRECT_HOSTS.has(current.hostname) ||
      current.username ||
      current.password ||
      (current.port !== "" && current.port !== "443")
    ) {
      fail(`Refusing an unexpected GitHub download URL: ${current.origin}`);
    }
    const response = await fetch(current, { headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) {
      fail("GitHub asset download exceeded its redirect limit.");
    }
    current = new URL(location, current);
  }
  fail("GitHub asset download exceeded its redirect limit.");
}

function assertApiAsset(asset, releaseId) {
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    asset.url !== `${GITHUB_API}/repos/${REPOSITORY}/releases/assets/${asset.id}` ||
    asset.state !== "uploaded" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  ) {
    invalidRelease(`Release ${releaseId} has invalid metadata for asset ${String(asset.name)}.`);
  }
}

async function downloadAsset(asset, destination, { expectedBytes, expectedSha256, maxBytes }) {
  const response = await fetchHttps(asset.url, { Accept: "application/octet-stream" });
  if (!response.ok || !response.body) {
    fail(`GitHub asset ${asset.name} download failed with HTTP ${response.status}.`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`GitHub asset ${asset.name} exceeds its allowed byte limit.`);
      }
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  await pipeline(
    response.body,
    meter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const sha256 = hash.digest("hex");
  if (
    bytes !== asset.size ||
    (expectedBytes !== undefined && bytes !== expectedBytes) ||
    (expectedSha256 !== undefined && sha256 !== expectedSha256)
  ) {
    fail(`GitHub asset ${asset.name} did not match its signed size and SHA-256 pins.`);
  }
  return { bytes, sha256 };
}

async function releaseAssetBytes(release, name) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) {
    invalidRelease(`Release ${release.tag_name} must contain exactly one ${name} asset.`);
  }
  const asset = matches[0];
  assertApiAsset(asset, release.tag_name);
  if (asset.size > MAX_MANIFEST_BYTES) {
    invalidRelease(`Release metadata asset ${name} exceeds its size limit.`);
  }
  const response = await fetchHttps(asset.url, { Accept: "application/octet-stream" });
  if (response.status === 404) {
    invalidRelease(`Release ${release.tag_name} is missing its ${name} asset.`);
  }
  if (!response.ok) {
    fail(`GitHub asset ${name} download failed with HTTP ${response.status}.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_MANIFEST_BYTES) {
      invalidRelease(`Release metadata asset ${name} exceeds its size limit.`);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== asset.size || bytes.length > MAX_MANIFEST_BYTES) {
    invalidRelease(`GitHub metadata asset ${name} has an invalid size.`);
  }
  return { asset, bytes };
}

async function verifiedRelease(release) {
  let manifestBytes;
  let signatureBytes;
  try {
    const [manifestAsset, signatureAsset] = await Promise.all([
      releaseAssetBytes(release, RELEASE_MANIFEST_ASSET),
      releaseAssetBytes(release, RELEASE_SIGNATURE_ASSET),
    ]);
    manifestBytes = manifestAsset.bytes;
    signatureBytes = signatureAsset.bytes;
  } catch (error) {
    if (error instanceof InvalidReleaseError) {
      return null;
    }
    throw error;
  }
  let manifest;
  try {
    manifest = verifyReleaseManifestBytes(manifestBytes, signatureBytes);
  } catch {
    return null;
  }
  if (
    manifest.releaseTag !== release.tag_name ||
    manifest.channel !== "fork" ||
    manifest.keyId !== PASEO_RELEASE_MANIFEST_KEY_ID ||
    manifest.packageVersion.includes("-beta.")
  ) {
    return null;
  }
  for (const name of [manifest.macOS.closureArchive.name, manifest.macOS.closureManifest.name]) {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) {
      return null;
    }
    try {
      assertApiAsset(matches[0], release.tag_name);
    } catch (error) {
      if (error instanceof InvalidReleaseError) {
        return null;
      }
      throw error;
    }
  }
  return { release, manifest, manifestBytes, signatureBytes };
}

export async function chooseHighestVerifiedStableRelease(
  releases,
  verifyRelease = verifiedRelease,
) {
  const candidates = releases.filter(isStableForkRelease).sort((left, right) => {
    const leftSequence = sequenceFromTag(left.tag_name);
    const rightSequence = sequenceFromTag(right.tag_name);
    if (leftSequence === rightSequence) return 0;
    if (leftSequence > rightSequence) return -1;
    return 1;
  });
  let selected;
  for (const release of candidates) {
    const sequence = sequenceFromTag(release.tag_name);
    if (selected && sequence < BigInt(selected.manifest.releaseSequence)) {
      break;
    }
    const verified = await verifyRelease(release);
    if (!verified) {
      continue;
    }
    if (selected && verified.manifest.releaseSequence === selected.manifest.releaseSequence) {
      fail(
        `More than one signed stable release has sequence ${verified.manifest.releaseSequence}.`,
      );
    }
    if (!selected || verified.manifest.releaseSequence > selected.manifest.releaseSequence) {
      selected = verified;
    }
  }
  if (!selected) {
    fail("No valid signed stable Paseo fork release was found.");
  }
  return selected;
}

async function listStableReleases() {
  let url = `${GITHUB_API}/repos/${REPOSITORY}/releases?per_page=100`;
  const releases = [];
  while (url) {
    const response = await fetchHttps(url, API_HEADERS);
    if (!response.ok) {
      fail(`GitHub releases API returned HTTP ${response.status}.`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) {
      fail("GitHub releases API returned an invalid response.");
    }
    releases.push(...batch.filter(isStableForkRelease));
    const link = response.headers.get("link") ?? "";
    const next = [...link.matchAll(/<([^>]+)>;\s*rel="next"/g)][0]?.[1];
    if (next) {
      const nextUrl = new URL(next);
      if (
        nextUrl.origin !== GITHUB_API ||
        nextUrl.pathname !== `/repos/${REPOSITORY}/releases` ||
        nextUrl.searchParams.get("per_page") !== "100"
      ) {
        fail("GitHub releases API returned an unexpected pagination link.");
      }
      url = nextUrl.href;
    } else {
      url = "";
    }
  }
  return releases;
}

function nix(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync("nix", args, {
    cwd: ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    fail(`Could not run nix ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const details = capture ? String(result.stderr ?? "").trim() : "";
    fail(`nix ${args[0]} failed${details ? `: ${details}` : "."}`);
  }
  return { status: result.status, stdout: capture ? String(result.stdout ?? "") : "" };
}

function nixEnv(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync("nix-env", args, {
    cwd: ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    fail(`Could not run nix-env: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const details = capture ? String(result.stderr ?? "").trim() : "";
    fail(`nix-env failed${details ? `: ${details}` : "."}`);
  }
  return { status: result.status, stdout: capture ? String(result.stdout ?? "") : "" };
}

export function setProfile(profilePath, outputPath, { fixture = false } = {}) {
  const validOutput = fixture
    ? /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(outputPath)
    : /^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+$/.test(outputPath);
  if (!isAbsolute(profilePath) || !validOutput) {
    fail("Profile activation requires an absolute profile path and exact verified store output.");
  }
  const args = [
    "--set",
    "--profile",
    profilePath,
    "--option",
    "builders",
    "",
    "--option",
    "substituters",
    "",
    "--max-jobs",
    "0",
    outputPath,
  ];
  if (!fixture) {
    args.splice(
      args.indexOf("--max-jobs"),
      0,
      "--option",
      "require-sigs",
      "true",
      "--option",
      "trusted-public-keys",
      NIX_RELEASE_PUBLIC_KEY,
    );
  }
  nixEnv(args);
}

function manifestIdentity(manifest) {
  return `${manifest.sourceSha}-${manifest.releaseSequence}`;
}

async function ensureDataRoot() {
  await mkdir(join(DATA_ROOT, "receipts"), { recursive: true, mode: 0o700 });
  const root = await lstat(DATA_ROOT);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    fail("Paseo updater state directory must be a regular directory.");
  }
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function writeJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function receiptPaths(manifest) {
  const directory = join(DATA_ROOT, "receipts", manifestIdentity(manifest));
  return {
    directory,
    manifest: join(directory, "release-manifest.json"),
    signature: join(directory, "release-manifest.sig"),
    nixManifest: join(directory, "nix-closure-manifest.json"),
  };
}

async function persistReceipt(verified, nixManifestBytes) {
  const paths = receiptPaths(verified.manifest);
  const receiptFiles = [
    [paths.manifest, verified.manifestBytes],
    [paths.signature, verified.signatureBytes],
    [paths.nixManifest, nixManifestBytes],
  ];
  try {
    for (const [path, bytes] of receiptFiles) {
      const existing = await readFile(path);
      if (!existing.equals(bytes)) {
        fail("A different signed release receipt already exists for this identity.");
      }
    }
    return paths;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const receiptsRoot = dirname(paths.directory);
  const temporaryDirectory = await mkdtemp(join(receiptsRoot, ".receipt-"));
  try {
    await Promise.all([
      writeFile(join(temporaryDirectory, "release-manifest.json"), verified.manifestBytes, {
        mode: 0o600,
      }),
      writeFile(join(temporaryDirectory, "release-manifest.sig"), verified.signatureBytes, {
        mode: 0o600,
      }),
      writeFile(join(temporaryDirectory, "nix-closure-manifest.json"), nixManifestBytes, {
        mode: 0o600,
      }),
    ]);
    try {
      await rename(temporaryDirectory, paths.directory);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
        throw error;
      }
      const [manifestBytes, signatureBytes, storedNixManifest] = await Promise.all(
        receiptFiles.map(([path]) => readFile(path)),
      );
      if (
        !manifestBytes.equals(verified.manifestBytes) ||
        !signatureBytes.equals(verified.signatureBytes) ||
        !storedNixManifest.equals(nixManifestBytes)
      ) {
        fail("A different signed release receipt already exists for this identity.");
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return paths;
}

async function loadReceipt(directory) {
  const [manifestBytes, signatureBytes, nixManifestBytes] = await Promise.all([
    readFile(join(directory, "release-manifest.json")),
    readFile(join(directory, "release-manifest.sig")),
    readFile(join(directory, "nix-closure-manifest.json")),
  ]);
  const manifest = verifyReleaseManifestBytes(manifestBytes, signatureBytes);
  if (
    nixManifestBytes.length !== manifest.macOS.closureManifest.bytes ||
    createHash("sha256").update(nixManifestBytes).digest("hex") !==
      manifest.macOS.closureManifest.sha256
  ) {
    fail("Stored Nix closure manifest differs from the signed release asset pin.");
  }
  validateNixClosureManifest(nixManifestBytes, manifest);
  return { manifest, manifestBytes, signatureBytes, nixManifestBytes };
}

export function assertAboveHighWater(manifest, highWater) {
  if (highWater && manifest.releaseSequence <= highWater.manifest.releaseSequence) {
    fail(
      `Release sequence ${manifest.releaseSequence} is not above the previously activated sequence ${highWater.manifest.releaseSequence}.`,
    );
  }
}

export async function finishPendingActivation(pending, adapters) {
  const receipt = await adapters.loadReceipt(pending.identity);
  const outputPath = receipt.manifest.macOS.outputPath;
  if (pending.outputPath !== outputPath) {
    fail("Pending activation output differs from its signed release receipt.");
  }
  if ((await adapters.activeOutputPath()) === outputPath) {
    await adapters.writeHighWater({ identity: pending.identity, outputPath });
  }
  await adapters.clearPending();
}

export async function applyProfileActivation(identity, outputPath, adapters) {
  await adapters.writePending({ identity, outputPath });
  await adapters.setProfile(outputPath);
  if ((await adapters.activeOutputPath()) !== outputPath) {
    fail("Nix profile activation did not select the verified Paseo output.");
  }
  await adapters.writeHighWater({ identity, outputPath });
  await adapters.clearPending();
}

function isNixClosureEntry(entry) {
  return (
    typeof entry?.path === "string" &&
    /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/.test(entry.path) &&
    typeof entry?.narHash === "string" &&
    /^sha256-[A-Za-z0-9+/]{43}=$/.test(entry.narHash) &&
    Number.isSafeInteger(entry?.narSize) &&
    entry.narSize >= 0
  );
}

export function validateNixClosureManifest(bytes, releaseManifest) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("The signed Nix closure manifest is invalid JSON.");
  }
  if (
    value?.schemaVersion !== 1 ||
    value?.sourceSha !== releaseManifest.sourceSha ||
    value?.releaseSequence !== releaseManifest.releaseSequence ||
    value?.system !== "aarch64-darwin" ||
    value?.provenance !== "local-ci-build" ||
    value?.outputPath !== releaseManifest.macOS.outputPath ||
    !Array.isArray(value?.closure)
  ) {
    fail("The signed Nix closure manifest does not match the release identity.");
  }
  for (const entry of value.closure) {
    if (!isNixClosureEntry(entry)) {
      fail("The signed Nix closure manifest contains an invalid store path entry.");
    }
  }
  if (!value.closure.some((entry) => entry.path === releaseManifest.macOS.outputPath)) {
    fail("The signed Nix closure manifest does not contain the desktop output.");
  }
  const sorted = [...value.closure].sort((left, right) => left.path.localeCompare(right.path));
  if (sorted.some((entry, index) => entry.path !== value.closure[index].path)) {
    fail("The signed Nix closure manifest paths are not canonical.");
  }
  return value;
}

function closureMap(value) {
  return value.closure.map(({ path, narHash, narSize }) => ({ path, narHash, narSize }));
}

async function verifyImportedClosure(manifest, nixManifestBytes) {
  const nixManifest = validateNixClosureManifest(nixManifestBytes, manifest);
  const commonOptions = [
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
  nix([
    "store",
    "verify",
    "--recursive",
    "--sigs-needed",
    "1",
    ...commonOptions,
    manifest.macOS.outputPath,
  ]);
  const result = nix(
    ["path-info", "--json", "--recursive", ...commonOptions, manifest.macOS.outputPath],
    { capture: true },
  );
  let imported;
  try {
    imported = JSON.parse(result.stdout);
  } catch {
    fail("Nix returned invalid closure metadata.");
  }
  const actual = Object.entries(imported)
    .map(([path, info]) => ({ path, narHash: info.narHash, narSize: info.narSize }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expected = closureMap(nixManifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "Imported Nix closure paths, NAR hashes, or sizes differ from the release-pinned closure manifest.",
    );
  }
  nix(["path-info", ...commonOptions, manifest.macOS.outputPath]);
  return nixManifest;
}

class TarReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.finished = false;
  }

  async fill() {
    if (this.finished) {
      return;
    }
    const next = await this.iterator.next();
    if (next.done) {
      this.finished = true;
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
  }

  async read(size) {
    while (this.buffer.length < size && !this.finished) {
      await this.fill();
    }
    if (this.buffer.length < size) {
      fail("Nix closure tar archive ended unexpectedly.");
    }
    const bytes = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return bytes;
  }

  async copy(size, write) {
    let remaining = size;
    while (remaining > 0) {
      if (this.buffer.length === 0) {
        await this.fill();
        if (this.buffer.length === 0) {
          fail("Nix closure tar archive ended inside a file payload.");
        }
      }
      const count = Math.min(remaining, this.buffer.length);
      await write(this.buffer.subarray(0, count));
      this.buffer = this.buffer.subarray(count);
      remaining -= count;
    }
  }
}

function tarString(header, start, size) {
  const bytes = header.subarray(start, start + size);
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function tarOctal(header, start, size) {
  const value = header
    .subarray(start, start + size)
    .toString("ascii")
    .replace(/[\0 ]+$/g, "")
    .trim();
  if (!/^[0-7]+$/.test(value)) {
    fail("Nix closure tar contains an unsupported numeric field.");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("Nix closure tar contains an invalid size.");
  }
  return parsed;
}

function safeTarPath(name, destination) {
  if (!name || name.includes("\\") || name.startsWith("/")) {
    fail(`Nix closure tar contains an unsafe member path: ${name}`);
  }
  const parts = name
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter((part) => part !== "");
  if (parts.some((part) => part === ".." || part === ".")) {
    if (!(parts.length === 1 && parts[0] === ".")) {
      fail(`Nix closure tar contains an unsafe member path: ${name}`);
    }
  }
  if (parts.length === 0) {
    return destination;
  }
  const path = resolve(destination, ...parts);
  const relativePath = relative(destination, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail(`Nix closure tar member escapes its staging directory: ${name}`);
  }
  return path;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    offset += result.bytesWritten;
  }
}

async function finishTar(reader) {
  const second = await reader.read(512);
  if (!second.every((byte) => byte === 0)) {
    fail("Nix closure tar has a malformed end marker.");
  }
  while (!reader.finished || reader.buffer.length > 0) {
    if (reader.buffer.length && reader.buffer.some((byte) => byte !== 0)) {
      fail("Nix closure tar has unexpected data after its end marker.");
    }
    reader.buffer = Buffer.alloc(0);
    if (!reader.finished) {
      await reader.fill();
    }
  }
}

function parseTarHeader(header, destination) {
  const storedChecksum = tarOctal(header, 148, 8);
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (checksum !== storedChecksum) {
    fail("Nix closure tar header checksum is invalid.");
  }
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const memberName = prefix ? `${prefix}/${name}` : name;
  const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
  const size = tarOctal(header, 124, 12);
  const path = safeTarPath(memberName, destination);
  if (type !== "0" && type !== "5") {
    fail(`Nix closure tar contains unsupported member type ${JSON.stringify(type)}.`);
  }
  if (type === "5" && size !== 0) {
    fail("Nix closure tar directory has a payload.");
  }
  return { memberName, path, type, size };
}

async function extractTarMember(reader, member, destination) {
  if (member.type === "5") {
    if (member.path !== destination) {
      await mkdir(member.path, { recursive: true, mode: 0o700 });
    }
    return { files: 0, extractedBytes: 0 };
  }
  const metadataOnly = member.memberName.split("/").at(-1)?.startsWith("._") ?? false;
  if (metadataOnly) {
    await reader.copy(member.size, async () => {});
    return { files: 0, extractedBytes: 0 };
  }
  await mkdir(dirname(member.path), { recursive: true, mode: 0o700 });
  const handle = await open(member.path, "wx", 0o600);
  try {
    await reader.copy(member.size, (chunk) => writeAll(handle, chunk));
  } finally {
    await handle.close();
  }
  return { files: 1, extractedBytes: member.size };
}

export async function extractNixCacheTar(archivePath, destination) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const root = await lstat(destination);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    fail("Nix cache extraction target must be a new regular directory.");
  }
  const reader = new TarReader(createReadStream(archivePath));
  let files = 0;
  let extractedBytes = 0;
  while (true) {
    const header = await reader.read(512);
    if (header.every((byte) => byte === 0)) {
      await finishTar(reader);
      break;
    }
    const member = parseTarHeader(header, destination);
    const extracted = await extractTarMember(reader, member, destination);
    files += extracted.files;
    extractedBytes += extracted.extractedBytes;
    const padding = (512 - (member.size % 512)) % 512;
    if (padding) {
      await reader.read(padding);
    }
  }
  if (files === 0 || extractedBytes === 0) {
    fail("Nix closure cache archive is empty.");
  }
  return { files, extractedBytes };
}

function nixOptions() {
  return [
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
}

async function assertFreeSpace(archiveBytes, closureBytes) {
  const { statfs } = await import("node:fs/promises");
  const disk = await statfs(DATA_ROOT);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const requiredBytes = archiveBytes + closureBytes * 2 + 100 * 1024 * 1024;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < requiredBytes) {
    fail(
      `Insufficient free disk space: have ${freeBytes} bytes; need about ${requiredBytes} bytes to stage and import the signed closure.`,
    );
  }
}

function assetFromRelease(release, name) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) {
    fail(`Release ${release.tag_name} must contain exactly one ${name} asset.`);
  }
  assertApiAsset(matches[0], release.tag_name);
  return matches[0];
}

async function stageVerifiedRelease(verified) {
  await ensureDataRoot();
  const manifest = verified.manifest;
  const archiveAsset = assetFromRelease(verified.release, manifest.macOS.closureArchive.name);
  const nixManifestAsset = assetFromRelease(verified.release, manifest.macOS.closureManifest.name);
  if (
    archiveAsset.size !== manifest.macOS.closureArchive.bytes ||
    nixManifestAsset.size !== manifest.macOS.closureManifest.bytes
  ) {
    fail("Release asset sizes differ from the signed manifest.");
  }
  const nixManifestResponse = await releaseAssetBytes(verified.release, nixManifestAsset.name);
  const nixManifestBytes = nixManifestResponse.bytes;
  if (
    createHash("sha256").update(nixManifestBytes).digest("hex") !==
      manifest.macOS.closureManifest.sha256 ||
    nixManifestBytes.length !== manifest.macOS.closureManifest.bytes
  ) {
    fail("Nix closure metadata differs from its signed release asset pin.");
  }
  const nixManifest = validateNixClosureManifest(nixManifestBytes, manifest);
  const closureBytes = nixManifest.closure.reduce((total, entry) => total + entry.narSize, 0);
  await assertFreeSpace(archiveAsset.size, closureBytes);

  const downloadRoot = await mkdtemp(join(DATA_ROOT, "download-"));
  const archivePath = join(downloadRoot, manifest.macOS.closureArchive.name);
  const cachePath = join(downloadRoot, "cache");
  try {
    await downloadAsset(archiveAsset, archivePath, {
      expectedBytes: manifest.macOS.closureArchive.bytes,
      expectedSha256: manifest.macOS.closureArchive.sha256,
      maxBytes: manifest.macOS.closureArchive.bytes,
    });
    const extraction = await extractNixCacheTar(archivePath, cachePath);
    nix(["copy", "--from", `file://${cachePath}`, ...nixOptions(), manifest.macOS.outputPath]);
    await verifyImportedClosure(manifest, nixManifestBytes);
    const receipt = await persistReceipt(verified, nixManifestBytes);
    setProfile(STAGING_PROFILE, manifest.macOS.outputPath);
    await writeJson(join(DATA_ROOT, "staged.json"), {
      identity: manifestIdentity(manifest),
      outputPath: manifest.macOS.outputPath,
      releaseTag: manifest.releaseTag,
      stagedAt: new Date().toISOString(),
      extractedBytes: extraction.extractedBytes,
      extractedFiles: extraction.files,
    });
    return { ...receipt, extraction };
  } finally {
    await rm(downloadRoot, { recursive: true, force: true });
  }
}

async function activeOutputPath(profilePath = ACTIVE_PROFILE) {
  try {
    const info = await lstat(profilePath);
    if (!info.isSymbolicLink()) {
      fail("Managed Paseo profile is not a Nix profile symlink.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const outputPath = await realpath(profilePath);
  if (!/^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+$/.test(outputPath)) {
    fail("Managed Paseo profile does not point directly to an exact desktop output.");
  }
  return outputPath;
}

async function loadHighWater() {
  let value;
  try {
    value = JSON.parse(await readFile(join(DATA_ROOT, "high-water.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (
    typeof value.identity !== "string" ||
    !/^[a-f0-9]{40}-[1-9][0-9]*$/.test(value.identity) ||
    typeof value.outputPath !== "string"
  ) {
    fail("Paseo updater high-water record is invalid.");
  }
  const receipt = await loadReceipt(join(DATA_ROOT, "receipts", value.identity));
  if (
    manifestIdentity(receipt.manifest) !== value.identity ||
    receipt.manifest.macOS.outputPath !== value.outputPath
  ) {
    fail("Paseo updater high-water record differs from its signed release receipt.");
  }
  return { ...value, manifest: receipt.manifest };
}

async function writeHighWater({ identity, outputPath }) {
  const receipt = await loadReceipt(join(DATA_ROOT, "receipts", identity));
  const manifest = receipt.manifest;
  if (manifest.macOS.outputPath !== outputPath) {
    fail("Cannot advance high-water state from an unmatched release receipt.");
  }
  const current = await loadHighWater();
  if (current && manifest.releaseSequence < current.manifest.releaseSequence) {
    fail("Paseo updater high-water sequence cannot decrease.");
  }
  if (
    current &&
    manifest.releaseSequence === current.manifest.releaseSequence &&
    current.identity !== identity
  ) {
    fail("Two signed releases share the current high-water sequence.");
  }
  await writeJson(join(DATA_ROOT, "high-water.json"), { identity, outputPath });
}

async function reconcilePendingActivation() {
  const pendingPath = join(DATA_ROOT, "pending-activation.json");
  let pending;
  try {
    pending = JSON.parse(await readFile(pendingPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    typeof pending.identity !== "string" ||
    !/^[a-f0-9]{40}-[1-9][0-9]*$/.test(pending.identity)
  ) {
    fail("Pending activation record is invalid.");
  }
  await finishPendingActivation(pending, {
    loadReceipt: (identity) => loadReceipt(join(DATA_ROOT, "receipts", identity)),
    activeOutputPath: () => activeOutputPath(),
    writeHighWater,
    clearPending: () => rm(pendingPath, { force: true }),
  });
}

async function receiptForOutput(outputPath) {
  const receiptsRoot = join(DATA_ROOT, "receipts");
  let entries;
  try {
    entries = await readdir(receiptsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{40}-[1-9][0-9]*$/.test(entry.name)) {
      continue;
    }
    const receipt = await loadReceipt(join(receiptsRoot, entry.name));
    if (receipt.manifest.macOS.outputPath === outputPath) {
      return receipt;
    }
  }
  return null;
}

async function currentReceipt() {
  await reconcilePendingActivation();
  const outputPath = await activeOutputPath();
  if (!outputPath) {
    return { outputPath: null, receipt: null };
  }
  const receipt = await receiptForOutput(outputPath);
  return { outputPath, receipt };
}

async function printCheck({ stage = false } = {}) {
  assertMacArm();
  const releases = await listStableReleases();
  const latest = await chooseHighestVerifiedStableRelease(releases);
  await ensureDataRoot();
  const { outputPath, receipt } = await currentReceipt();
  let highWater = await loadHighWater();
  if (!highWater && receipt && stage) {
    await writeHighWater({ identity: manifestIdentity(receipt.manifest), outputPath });
    highWater = await loadHighWater();
  }
  const currentSequence = receipt?.manifest.releaseSequence ?? 0;
  const highestSequence = highWater?.manifest.releaseSequence ?? currentSequence;
  if (!stage) {
    process.stdout.write(
      `${latest.manifest.releaseTag} ${latest.manifest.packageVersion} (sequence ${latest.manifest.releaseSequence})\n`,
    );
    if (outputPath && !receipt) {
      process.stdout.write(
        `Managed profile points to ${outputPath}; its signed release receipt is unknown.\n`,
      );
    } else if (latest.manifest.releaseSequence <= highestSequence) {
      if (receipt && currentSequence < highestSequence) {
        process.stdout.write(
          `The managed profile is rolled back to sequence ${currentSequence}; sequence ${highestSequence} was already activated. The candidate cannot be staged because it does not exceed the high-water mark.\n`,
        );
      } else {
        process.stdout.write(
          "The managed profile is current or newer; no higher sequence can be staged.\n",
        );
      }
    } else {
      process.stdout.write("A newer verified stable fork release is available.\n");
    }
    return;
  }
  if (stage && outputPath && !receipt) {
    fail(
      "The existing managed profile has no matching signed release receipt; refusing to replace it.",
    );
  }
  if (latest.manifest.releaseSequence <= highestSequence) {
    fail(
      "The highest verified stable release is not newer than the highest sequence previously activated.",
    );
  }
  await stageVerifiedRelease(latest);
  process.stdout.write(
    `Staged ${latest.manifest.releaseTag}; the active app profile was not changed.\n`,
  );
}

async function activateStagedRelease() {
  assertMacArm();
  await ensureDataRoot();
  await reconcilePendingActivation();
  const staged = JSON.parse(await readFile(join(DATA_ROOT, "staged.json"), "utf8"));
  if (typeof staged.identity !== "string" || !/^[a-f0-9]{40}-[1-9][0-9]*$/.test(staged.identity)) {
    fail("Staged release record is invalid.");
  }
  const receipt = await loadReceipt(join(DATA_ROOT, "receipts", staged.identity));
  const manifest = receipt.manifest;
  if (staged.outputPath !== manifest.macOS.outputPath) {
    fail("Staged release output path differs from the signed manifest.");
  }
  await verifyImportedClosure(manifest, receipt.nixManifestBytes);
  const { outputPath: currentPath, receipt: current } = await currentReceipt();
  if (currentPath && !current) {
    fail(
      "The existing managed profile has no matching signed release receipt; refusing to replace it.",
    );
  }
  let highWater = await loadHighWater();
  if (!highWater && current) {
    await writeHighWater({ identity: manifestIdentity(current.manifest), outputPath: currentPath });
    highWater = await loadHighWater();
  }
  assertAboveHighWater(manifest, highWater);
  if (currentPath === manifest.macOS.outputPath) {
    fail("The staged output is already active.");
  }
  await applyProfileActivation(manifestIdentity(manifest), manifest.macOS.outputPath, {
    writePending: (pending) => writeJson(join(DATA_ROOT, "pending-activation.json"), pending),
    setProfile: (outputPath) => setProfile(ACTIVE_PROFILE, outputPath),
    activeOutputPath: () => activeOutputPath(),
    writeHighWater,
    clearPending: () => rm(join(DATA_ROOT, "pending-activation.json"), { force: true }),
  });
  process.stdout.write(
    `Activated ${manifest.releaseTag}. Any already-running Paseo process was left untouched.\n`,
  );
}

async function printStatus() {
  assertMacArm();
  await ensureDataRoot();
  const { outputPath, receipt } = await currentReceipt();
  if (!outputPath) {
    process.stdout.write("No managed Paseo profile is active.\n");
    return;
  }
  if (!receipt) {
    process.stdout.write(`Managed profile contains an unrecognized output: ${outputPath}\n`);
    return;
  }
  let highWater = await loadHighWater();
  process.stdout.write(
    `Active ${receipt.manifest.releaseTag} ${receipt.manifest.packageVersion} (sequence ${receipt.manifest.releaseSequence})\nHighest activated sequence ${highWater?.manifest.releaseSequence ?? receipt.manifest.releaseSequence}\n${outputPath}\n`,
  );
}

async function rollbackProfile() {
  assertMacArm();
  await ensureDataRoot();
  await reconcilePendingActivation();
  const before = await activeOutputPath();
  if (!before) {
    fail("There is no managed Paseo profile to roll back.");
  }
  nixEnv(["--rollback", "--profile", ACTIVE_PROFILE]);
  const after = await activeOutputPath();
  if (after === before) {
    fail("Nix profile rollback did not change the active generation.");
  }
  const receipt = await receiptForOutput(after);
  if (receipt) {
    process.stdout.write(`Rolled back to ${receipt.manifest.releaseTag}.\n`);
  } else {
    process.stdout.write(
      `Rolled back to prior Nix generation ${after}; no signed Paseo release receipt was recorded for it.\n`,
    );
  }
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: paseo-nix-update <check|stage|activate|status|rollback>",
      "  check     Find the highest verified stable fork release.",
      "  stage     Verify and import a newer signed closure without changing the active profile.",
      "  activate  Atomically select the staged output in Paseo's dedicated Nix profile.",
      "  status    Show the active managed profile generation.",
      "  rollback  Switch to the previous Nix profile generation.",
      "",
      "Supported only on Apple Silicon macOS. No app or daemon is restarted.",
    ].join("\n"),
  );
}

export async function runPaseoNixUpdate(argv = process.argv.slice(2)) {
  const [command = "help", ...rest] = argv;
  if (
    rest.length ||
    !["help", "--help", "check", "stage", "activate", "status", "rollback"].includes(command)
  ) {
    fail("Expected exactly one command: check, stage, activate, status, rollback, or --help.");
  }
  if (command === "help" || command === "--help") {
    printHelp();
  } else {
    assertMacArm();
    await ensureDataRoot();
    await withOperationLock(join(DATA_ROOT, "operation.lock"), async () => {
      if (command === "check") {
        await printCheck();
      } else if (command === "stage") {
        await printCheck({ stage: true });
      } else if (command === "activate") {
        await activateStagedRelease();
      } else if (command === "status") {
        await printStatus();
      } else {
        await rollbackProfile();
      }
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPaseoNixUpdate().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Paseo Nix update failed."}\n`,
    );
    process.exitCode = 1;
  });
}
