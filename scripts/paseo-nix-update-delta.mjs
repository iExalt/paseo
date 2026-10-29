// Unsigned download sidecars for the macOS Nix desktop release: an index of the
// release tar (member byte ranges plus every narinfo) and zstd --patch-from
// deltas of changed store paths against recent releases. The updater uses them
// to fetch only the store paths it lacks; release-mac-index.mjs writes them.
//
// Nothing here is trusted. Nix checks each path's release-key signature on
// import, which covers only StorePath, NarHash, NarSize and References, so a
// delta-built NAR can be served uncompressed under a rewritten narinfo that
// keeps the original Sig. Nix checks the NAR against the signed NarHash and
// NarSize but ignores FileHash and FileSize on a file:// import, so the FileHash
// checks here only fail early. The updater then compares the imported closure
// with the signed closure manifest. A bad sidecar only costs the full download.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchHttps, nix, nixOptions } from "./paseo-nix-update-legacy.mjs";

export const INDEX_KIND = "paseo-nix-desktop-index";
const NIX32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const STORE_PATH = /^\/nix\/store\/([0-9a-z]{32})-[^/]+$/;
const SRI_SHA256 = /^sha256-[A-Za-z0-9+/]{43}=$/;
const NIX32_SHA256 = /^sha256:[0-9a-z]{52}$/;
const MEMBER_NAME = /^(nix-cache-info|[0-9a-z]{32}\.narinfo|nar\/[0-9a-z]{52}\.nar(\.[a-z0-9]+)?)$/;
const NAR_URL = /^nar\/[0-9a-z]{52}\.nar(\.[a-z0-9]+)?$/;
const MAX_NARINFO_BYTES = 64 * 1024;
// The decoder only allows windows up to this; --patch-from sizes the window to
// the base NAR, so 31 (2 GiB) leaves room above today's 0.5 GB NAR.
const ZSTD_DECODE_LONG = "--long=31";

/** Nix's base-32 encoding (least significant bits first), as used in narinfo hashes. */
export function nix32(bytes) {
  let out = "";
  for (let n = Math.ceil((bytes.length * 8) / 5) - 1; n >= 0; n -= 1) {
    const bit = n * 5;
    const i = Math.floor(bit / 8);
    const j = bit % 8;
    const value = (bytes[i] >> j) | (i + 1 < bytes.length ? bytes[i + 1] << (8 - j) : 0);
    out += NIX32_ALPHABET[value & 0x1f];
  }
  return out;
}

const sriToNix32 = (sri) => `sha256:${nix32(Buffer.from(sri.slice(7), "base64"))}`;
const sha256File = (digest) => `sha256:${nix32(digest)}`;

export function indexAssetName(archiveName) {
  assert.match(archiveName, /\.tar$/);
  return archiveName.replace(/\.tar$/, ".index.json");
}

export function deltaAssetName(archiveName, fromVersion) {
  assert.match(archiveName, /\.tar$/);
  assert.match(fromVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  return archiveName.replace(/\.tar$/, `.delta-from-${fromVersion}.zst`);
}

export function parseNarinfo(text) {
  assert.ok(typeof text === "string" && text.length <= MAX_NARINFO_BYTES, "Invalid narinfo");
  const fields = new Map();
  const sigs = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const at = line.indexOf(": ");
    assert.ok(at > 0, "Malformed narinfo line");
    const [key, value] = [line.slice(0, at), line.slice(at + 2)];
    if (key === "Sig") sigs.push(value);
    else {
      assert.ok(!fields.has(key), `Duplicate narinfo field ${key}`);
      fields.set(key, value);
    }
  }
  const info = {
    storePath: fields.get("StorePath"),
    url: fields.get("URL"),
    compression: fields.get("Compression") ?? "bzip2",
    fileHash: fields.get("FileHash"),
    fileSize: Number(fields.get("FileSize")),
    narHash: fields.get("NarHash"),
    narSize: Number(fields.get("NarSize")),
    references: (fields.get("References") ?? "").split(" ").filter(Boolean),
    sigs,
  };
  assert.match(info.storePath ?? "", STORE_PATH, "Invalid narinfo StorePath");
  assert.match(info.url ?? "", NAR_URL, "Invalid narinfo URL");
  assert.match(info.fileHash ?? "", NIX32_SHA256, "Invalid narinfo FileHash");
  assert.match(info.narHash ?? "", NIX32_SHA256, "Invalid narinfo NarHash");
  assert.ok(Number.isSafeInteger(info.fileSize) && info.fileSize > 0, "Invalid narinfo FileSize");
  assert.ok(Number.isSafeInteger(info.narSize) && info.narSize > 0, "Invalid narinfo NarSize");
  return info;
}

/** What a narinfo Sig signs (Nix's ValidPathInfo::fingerprint). */
export function narinfoFingerprint(info) {
  const references = info.references.map((name) => `/nix/store/${name}`).join(",");
  return `1;${info.storePath};${info.narHash};${info.narSize};${references}`;
}

/** Replaces URL/Compression/FileHash/FileSize and keeps every signed field and Sig. */
export function rewriteNarinfo(text, replacements) {
  const pending = new Map(Object.entries(replacements));
  const lines = text.split("\n").map((line) => {
    const key = line.split(": ", 1)[0];
    if (!line.includes(": ") || !pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}: ${value}`;
  });
  assert.equal(pending.size, 0, "Narinfo lacks a field to rewrite");
  return lines.join("\n");
}

function tarText(header, start, size) {
  const bytes = header.subarray(start, start + size);
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function parseTarHeader(header) {
  let checksum = 0;
  for (let index = 0; index < 512; index += 1)
    checksum += index >= 148 && index < 156 ? 32 : header[index];
  const field = (start, size) => {
    const text = tarText(header, start, size).trim();
    assert.match(text, /^[0-7]+$/, "Unsupported tar numeric field");
    return Number.parseInt(text, 8);
  };
  assert.equal(field(148, 8), checksum, "Invalid tar header checksum");
  const name = tarText(header, 0, 100);
  const prefix = tarText(header, 345, 155);
  return {
    name: (prefix ? `${prefix}/${name}` : name).replace(/^(\.\/)+/, ""),
    type: header[156] === 0 ? "0" : String.fromCharCode(header[156]),
    size: field(124, 12),
  };
}

/** Yields each ustar member with its data offset; readAt(offset, length) returns bytes. */
export async function* walkTar(readAt, totalBytes) {
  let offset = 0;
  while (offset + 512 <= totalBytes) {
    const header = await readAt(offset, 512);
    if (header.every((byte) => byte === 0)) return;
    const member = parseTarHeader(header);
    yield { ...member, offset: offset + 512 };
    offset += 512 + Math.ceil(member.size / 512) * 512;
  }
  throw new Error("Nix cache tar is truncated");
}

async function hashFile(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest();
}

/** Index of a local release tar: regular members with byte ranges, and every narinfo. */
export async function buildIndex(archivePath, archiveName) {
  const handle = await open(archivePath, "r");
  try {
    const { size } = await handle.stat();
    const readAt = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      assert.equal(bytesRead, length, "Nix cache tar is truncated");
      return buffer;
    };
    const members = [];
    const narinfos = [];
    for await (const member of walkTar(readAt, size)) {
      if (member.type === "5") continue;
      assert.equal(member.type, "0", `Unsupported tar member ${member.name}`);
      members.push({ name: member.name, offset: member.offset, size: member.size });
      if (member.name.endsWith(".narinfo"))
        narinfos.push((await readAt(member.offset, member.size)).toString("utf8"));
    }
    narinfos.sort();
    return {
      schemaVersion: 1,
      kind: INDEX_KIND,
      archive: { name: archiveName, bytes: size, sha256: (await hashFile(archivePath)).toString("hex") },
      members,
      narinfos,
      deltas: [],
    };
  } finally {
    await handle.close();
  }
}

function exactKeys(value, keys, what) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `Invalid ${what}`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Unexpected ${what} fields`);
}

/**
 * Checks an unsigned index against the signed artifact and closure manifest.
 * Returns members by name, narinfos by store path, and the deltas.
 */
export function validateIndex(index, artifact, closure) {
  exactKeys(index, ["schemaVersion", "kind", "archive", "members", "narinfos", "deltas"], "index");
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.kind, INDEX_KIND);
  assert.deepEqual(
    index.archive,
    { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 },
    "Index describes another archive",
  );
  assert.ok(Array.isArray(index.members) && Array.isArray(index.narinfos));
  assert.ok(Array.isArray(index.deltas));
  const members = new Map();
  for (const member of index.members) {
    exactKeys(member, ["name", "offset", "size"], "index member");
    assert.match(member.name, MEMBER_NAME, "Unexpected index member name");
    assert.ok(!members.has(member.name), "Duplicate index member");
    assert.ok(
      Number.isSafeInteger(member.offset) &&
        member.offset >= 512 &&
        member.offset % 512 === 0 &&
        Number.isSafeInteger(member.size) &&
        member.size >= 0 &&
        member.offset + member.size <= artifact.bytes,
      "Index member lies outside the archive",
    );
    members.set(member.name, member);
  }
  const expected = new Map(closure.closure.map((entry) => [entry.path, entry]));
  const narinfos = new Map();
  for (const text of index.narinfos) {
    const info = parseNarinfo(text);
    const entry = expected.get(info.storePath);
    assert.ok(entry, "Index narinfo names a path outside the signed closure");
    assert.ok(!narinfos.has(info.storePath), "Duplicate index narinfo");
    assert.equal(info.narHash, sriToNix32(entry.narHash), "Index narinfo differs from signed NarHash");
    assert.equal(info.narSize, entry.narSize, "Index narinfo differs from signed NarSize");
    assert.equal(members.get(info.url)?.size, info.fileSize, "Index narinfo has no matching NAR");
    narinfos.set(info.storePath, { text, info });
  }
  assert.equal(narinfos.size, expected.size, "Index lacks a narinfo for the signed closure");
  const deltaName = new RegExp(
    `^${artifact.name.replace(/\.tar$/, "").replace(/[.]/g, "\\.")}\\.delta-from-[0-9]+\\.[0-9]+\\.[0-9]+\\.zst$`,
  );
  for (const delta of index.deltas) {
    exactKeys(delta, ["fromPath", "fromNarHash", "toPath", "asset", "bytes", "sha256"], "delta");
    assert.match(delta.fromPath, STORE_PATH);
    assert.match(delta.fromNarHash, SRI_SHA256);
    assert.ok(expected.has(delta.toPath), "Delta targets a path outside the signed closure");
    assert.match(delta.asset, deltaName, "Unexpected delta asset name");
    assert.ok(Number.isSafeInteger(delta.bytes) && delta.bytes > 0 && delta.bytes <= artifact.bytes);
    assert.match(delta.sha256, /^[0-9a-f]{64}$/);
  }
  return { members, narinfos, deltas: index.deltas };
}

/**
 * Picks how to obtain each signed closure path the local store lacks: the
 * smallest delta whose base is valid locally with the expected NarHash, else
 * the path's compressed NAR range from the tar.
 */
export function planFetch({ closure, narinfos, deltas, invalid, local }) {
  return closure.closure
    .filter((entry) => invalid.has(entry.path))
    .map((entry) => {
      const [delta] = deltas
        .filter((d) => d.toPath === entry.path && local.get(d.fromPath)?.narHash === d.fromNarHash)
        .sort((a, b) => a.bytes - b.bytes);
      return delta ? { entry, delta } : { entry, narinfo: narinfos.get(entry.path).info };
    });
}

async function writeStream(readable, file, maxBytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new Error(`${file} exceeds its expected size`));
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  await pipeline(readable, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }));
  return { bytes, sha256: hash.digest() };
}

/** Downloads bytes [offset, offset + size) of a release asset through fetchImpl. */
export async function fetchRange(url, { offset, size, total }, file, { fetchImpl = fetchHttps, signal } = {}) {
  const end = offset + size - 1;
  const response = await fetchImpl(
    url,
    { Accept: "application/octet-stream", Range: `bytes=${offset}-${end}` },
    { signal },
  );
  assert.equal(response.status, 206, `Range request returned HTTP ${response.status}`);
  assert.equal(response.headers.get("content-range"), `bytes ${offset}-${end}/${total}`);
  const result = await writeStream(Readable.fromWeb(response.body), file, size);
  assert.equal(result.bytes, size, "Range response is truncated");
  return result;
}

async function fetchAsset(url, file, { bytes, sha256 }, { fetchImpl = fetchHttps, signal } = {}) {
  const response = await fetchImpl(url, { Accept: "application/octet-stream" }, { signal });
  assert.equal(response.status, 200, `Delta download returned HTTP ${response.status}`);
  const result = await writeStream(Readable.fromWeb(response.body), file, bytes);
  assert.ok(result.bytes === bytes && result.sha256.toString("hex") === sha256, "Delta differs from its index entry");
}

/** zstd -d, optionally against a --patch-from base, writing at most maxBytes. */
export async function zstdDecompress(input, output, maxBytes, { patchFrom } = {}) {
  const args = ["-d", "-q", "-c", ZSTD_DECODE_LONG];
  if (patchFrom) args.push(`--patch-from=${patchFrom}`);
  const child = spawn("zstd", [...args, input], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  let written;
  try {
    written = await writeStream(child.stdout, output, maxBytes);
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
  assert.equal(await exited, 0, `zstd failed: ${stderr.trim()}`);
  return written;
}

/** Writes a store path's NAR serialisation to a new file. */
export async function dumpPath(path, file) {
  const handle = await open(file, "wx", 0o600);
  try {
    const result = spawnSync("nix", ["store", "dump-path", path], {
      stdio: ["ignore", handle.fd, "pipe"],
      encoding: "utf8",
    });
    assert.ok(!result.error && result.status === 0, `nix store dump-path failed: ${result.stderr ?? result.error}`);
  } finally {
    await handle.close();
  }
}

export const localStore = {
  invalidPaths(paths) {
    const result = spawnSync("nix-store", ["--check-validity", "--print-invalid", ...paths], {
      encoding: "utf8",
    });
    assert.ok(!result.error && result.status === 0, `nix-store --check-validity failed: ${result.stderr}`);
    return new Set(result.stdout.split("\n").filter(Boolean));
  },
  pathInfo(paths) {
    if (paths.length === 0) return new Map();
    const info = JSON.parse(
      nix(["path-info", "--json", ...nixOptions(), ...paths], { capture: true }).stdout,
    );
    return new Map(
      Object.entries(info)
        .filter(([, value]) => value)
        .map(([path, value]) => [path, { narHash: value.narHash, narSize: value.narSize }]),
    );
  },
  dumpPath,
};

/**
 * Builds a file:// binary cache holding every narinfo of the signed closure and
 * the NARs of the paths the local store lacks, from deltas or tar ranges.
 * Throws on anything unexpected; the caller then downloads the full tar.
 */
export async function prepareIndexedCache({
  tag,
  artifact,
  closure,
  directory,
  downloadUrl,
  fetchBytes,
  freeSpace,
  fetchImpl = fetchHttps,
  store = localStore,
  signal,
}) {
  const indexBytes = await fetchBytes(downloadUrl(tag, indexAssetName(artifact.name)), "the update index");
  const index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes));
  const { members, narinfos, deltas } = validateIndex(index, artifact, closure);
  const bases = [...new Set(deltas.map((delta) => delta.fromPath))];
  const invalid = store.invalidPaths([...closure.closure.map((entry) => entry.path), ...bases]);
  const local = store.pathInfo(bases.filter((path) => !invalid.has(path)));
  const plan = planFetch({ closure, narinfos, deltas, invalid, local });
  const sum = (steps, size) => steps.reduce((total, step) => total + size(step), 0);
  const deltaSteps = plan.filter((step) => step.delta);
  await freeSpace(
    sum(plan, (step) => (step.delta ? step.delta.bytes : step.narinfo.fileSize)) +
      sum(deltaSteps, (step) => local.get(step.delta.fromPath).narSize + step.entry.narSize),
    sum(plan, (step) => step.entry.narSize),
  );

  const cache = join(directory, "cache");
  await mkdir(join(cache, "nar"), { recursive: true, mode: 0o700 });
  await writeFile(join(cache, "nix-cache-info"), "StoreDir: /nix/store\n");
  for (const [path, { text }] of narinfos)
    await writeFile(join(cache, `${STORE_PATH.exec(path)[1]}.narinfo`), text);
  const archiveUrl = downloadUrl(tag, artifact.name);
  let transferred = indexBytes.length;
  for (const step of plan) {
    const hashPart = STORE_PATH.exec(step.entry.path)[1];
    if (step.narinfo) {
      const member = members.get(step.narinfo.url);
      const { sha256 } = await fetchRange(
        archiveUrl,
        { ...member, total: artifact.bytes },
        join(cache, step.narinfo.url),
        { fetchImpl, signal },
      );
      // Early failure only; Nix enforces the signed NarHash on import.
      assert.equal(sha256File(sha256), step.narinfo.fileHash, "Tar range differs from its FileHash");
      transferred += member.size;
      continue;
    }
    const base = join(directory, "base.nar");
    const patch = join(directory, "delta.zst");
    await store.dumpPath(step.delta.fromPath, base);
    await fetchAsset(downloadUrl(tag, step.delta.asset), patch, step.delta, { fetchImpl, signal });
    const narHash = sriToNix32(step.entry.narHash);
    const name = `nar/${narHash.slice(7)}.nar`;
    const built = await zstdDecompress(patch, join(cache, name), step.entry.narSize, {
      patchFrom: base,
    });
    assert.ok(
      built.bytes === step.entry.narSize &&
        `sha256-${built.sha256.toString("base64")}` === step.entry.narHash,
      "Delta output differs from the signed NarHash",
    );
    await writeFile(
      join(cache, `${hashPart}.narinfo`),
      rewriteNarinfo(narinfos.get(step.entry.path).text, {
        URL: name,
        Compression: "none",
        FileHash: narHash,
        FileSize: String(step.entry.narSize),
      }),
    );
    await rm(base);
    await rm(patch);
    transferred += step.delta.bytes;
  }
  return { cache, plan, transferred };
}

export { hashFile, sriToNix32, sha256File };
