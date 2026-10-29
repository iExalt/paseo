import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildIndex,
  fetchRange,
  invalidPathsArgs,
  narinfoFingerprint,
  nix32,
  parseNarinfo,
  pathInfoArgs,
  planFetch,
  prepareIndexedCache,
  rewriteNarinfo,
  validateIndex,
  walkTar,
  ZSTD_WINDOW_LOG,
} from "./paseo-nix-update-delta.mjs";
import { importWithFallback, releaseDownloadUrl } from "./paseo-nix-update.mjs";

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-nix-delta-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() =>
  Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

function tarFile(name, contents, type = "0") {
  const bytes = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const sri = (bytes) => `sha256-${sha256(bytes).toString("base64")}`;

function zstd(args) {
  const result = spawnSync("zstd", ["-q", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// A two-path release: dep is valid locally; desktop is not, and has a delta
// from base (the previous release's desktop path, installed locally).
async function deltaRelease(directory) {
  const lines = (tag) =>
    Buffer.from(Array.from({ length: 4000 }, (_, i) => `${i % 7 === 0 ? tag : "line"} ${i}\n`).join(""));
  const nars = { dep: Buffer.from("dep nar\n".repeat(100)), desktop: lines("v3"), base: lines("v2") };
  const paths = {
    dep: `/nix/store/${"a".repeat(32)}-dep`,
    desktop: `/nix/store/${"b".repeat(32)}-paseo-desktop-1.2.3`,
    base: `/nix/store/${"c".repeat(32)}-paseo-desktop-1.2.2`,
  };
  const name = "paseo-1.2.3-macos-arm64-nix-desktop";
  const files = {};
  const tarParts = [tarFile("./nix-cache-info", "StoreDir: /nix/store\n")];
  const narinfos = {};
  for (const key of ["dep", "desktop", "base"]) {
    await writeFile(join(directory, `${key}.nar`), nars[key]);
    if (key === "base") continue;
    zstd([join(directory, `${key}.nar`), "-o", join(directory, `${key}.nar.zst`)]);
    const zst = await readFile(join(directory, `${key}.nar.zst`));
    const url = `nar/${nix32(sha256(zst))}.nar.zst`;
    narinfos[key] = [
      `StorePath: ${paths[key]}`,
      `URL: ${url}`,
      "Compression: zstd",
      `FileHash: sha256:${nix32(sha256(zst))}`,
      `FileSize: ${zst.length}`,
      `NarHash: sha256:${nix32(sha256(nars[key]))}`,
      `NarSize: ${nars[key].length}`,
      `References: ${key === "desktop" ? `${"a".repeat(32)}-dep` : ""}`,
      "Sig: paseo-nix-release-1:c2lnbmF0dXJl",
      "",
    ].join("\n");
    tarParts.push(tarFile(`./${paths[key].slice(11, 43)}.narinfo`, narinfos[key]));
    tarParts.push(tarFile(`./${url}`, zst));
  }
  const tar = Buffer.concat([...tarParts, Buffer.alloc(1024)]);
  files[`${name}.tar`] = tar;
  await writeFile(join(directory, `${name}.tar`), tar);
  const index = await buildIndex(join(directory, `${name}.tar`), `${name}.tar`);
  zstd([
    `--long=${ZSTD_WINDOW_LOG}`,
    `--patch-from=${join(directory, "base.nar")}`,
    join(directory, "desktop.nar"),
    "-o",
    join(directory, "delta.zst"),
  ]);
  const delta = await readFile(join(directory, "delta.zst"));
  const deltaName = `${name}.delta-from-1.2.2.zst`;
  files[deltaName] = delta;
  index.deltas.push({
    fromPath: paths.base,
    fromNarHash: sri(nars.base),
    toPath: paths.desktop,
    asset: deltaName,
    bytes: delta.length,
    sha256: sha256(delta).toString("hex"),
  });
  files[`${name}.index.json`] = Buffer.from(JSON.stringify(index));
  const closure = {
    closure: ["dep", "desktop"].map((key) => ({
      path: paths[key],
      narHash: sri(nars[key]),
      narSize: nars[key].length,
    })),
  };
  const artifact = { name: `${name}.tar`, bytes: tar.length, sha256: sha256(tar).toString("hex") };
  return { nars, paths, narinfos, index, closure, artifact, files, deltaName };
}

async function serveRelease(files) {
  const requests = [];
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.split("/").at(-1));
    const body = files[name];
    requests.push(request.headers.range ? `${name} ${request.headers.range}` : name);
    if (!body) return response.writeHead(404).end();
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (!range) return response.writeHead(200).end(body);
    const [start, end] = [Number(range[1]), Number(range[2])];
    response
      .writeHead(206, { "content-range": `bytes ${start}-${end}/${body.length}` })
      .end(body.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, headers, options) =>
    fetch(url.replace("https://github.com", origin), { headers, ...options });
  return { server, requests, fetchImpl };
}

describe("Paseo Nix updater partial downloads", () => {
  it("rewrites a narinfo to an uncompressed NAR without changing what its Sig signs", () => {
    assert.equal(nix32(sha256(Buffer.alloc(0))), "0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73");
    const text = [
      `StorePath: /nix/store/${"b".repeat(32)}-x`,
      `URL: nar/${"1".repeat(52)}.nar.zst`,
      "Compression: zstd",
      `FileHash: sha256:${"1".repeat(52)}`,
      "FileSize: 10",
      `NarHash: sha256:${"2".repeat(52)}`,
      "NarSize: 20",
      `References: ${"a".repeat(32)}-dep`,
      "Sig: key-1:abc",
      "",
    ].join("\n");
    assert.throws(() => parseNarinfo(text.replace("URL: nar/", "URL: ../")), /URL/);
    assert.throws(() => parseNarinfo(`${text}NarSize: 1\n`), /Duplicate/);
    const rewritten = parseNarinfo(
      rewriteNarinfo(text, {
        URL: `nar/${"2".repeat(52)}.nar`,
        Compression: "none",
        FileHash: `sha256:${"2".repeat(52)}`,
        FileSize: "20",
      }),
    );
    const original = parseNarinfo(text);
    assert.equal(narinfoFingerprint(rewritten), narinfoFingerprint(original));
    assert.deepEqual(rewritten.sigs, ["key-1:abc"]);
    assert.deepEqual([rewritten.url, rewritten.compression], [`nar/${"2".repeat(52)}.nar`, "none"]);
  });

  it("walks ustar members with their data offsets and rejects a bad checksum", async () => {
    const tar = Buffer.concat([tarFile("./nar/", "", "5"), tarFile("./a.narinfo", "x".repeat(600)), tarFile("./b", "y"), Buffer.alloc(1024)]);
    const readAt = async (offset, length) => tar.subarray(offset, offset + length);
    const members = [];
    for await (const member of walkTar(readAt, tar.length)) members.push(member);
    assert.deepEqual(members, [
      { name: "nar/", type: "5", size: 0, offset: 512 },
      { name: "a.narinfo", type: "0", size: 600, offset: 1024 },
      { name: "b", type: "0", size: 1, offset: 2560 },
    ]);
    tar[2048 + 10] ^= 1;
    await assert.rejects(async () => {
      for await (const _ of walkTar(readAt, tar.length));
    }, /checksum/);
    await assert.rejects(async () => {
      for await (const _ of walkTar(readAt, 1536));
    }, /truncated/);
  });

  it("accepts only an index bound to the signed archive and covering the signed closure", async () => {
    const release = await deltaRelease(await temporaryDirectory());
    const { index, artifact, closure } = release;
    assert.equal(validateIndex(index, artifact, closure).narinfos.size, 2);
    const rejects = (mutate, pattern) => {
      const copy = structuredClone(index);
      const signed = structuredClone(closure);
      mutate(copy, signed);
      assert.throws(() => validateIndex(copy, artifact, signed), pattern);
    };
    rejects((copy) => (copy.archive.sha256 = "0".repeat(64)), /another archive/);
    // nix copy needs every closure narinfo, even for paths already valid locally.
    rejects((copy) => copy.narinfos.pop(), /lacks a narinfo/);
    rejects((_, signed) => (signed.closure[0].narHash = sri(Buffer.from("x"))), /signed NarHash/);
    rejects((copy) => copy.narinfos.push(copy.narinfos[0]), /Duplicate index narinfo/);
    rejects((copy) => (copy.members.at(-1).offset = artifact.bytes), /outside the archive/);
    rejects((copy) => copy.members.reverse(), /overlap or are out of order/);
    rejects((copy) => (copy.members[0].name = "../nix-cache-info"), /member name/);
    rejects((copy) => (copy.deltas[0].asset = "other.zst"), /delta asset name/);
  });

  it("fetches only invalid paths, by the smallest delta whose base hash matches", () => {
    const entry = (path) => ({ path, narHash: sri(Buffer.from(path)), narSize: 1 });
    const closure = { closure: [entry("/nix/store/a"), entry("/nix/store/b")] };
    const narinfos = new Map([["/nix/store/b", { info: { url: "nar/b", fileSize: 100 } }]]);
    const delta = (fromPath, bytes) => ({ fromPath, fromNarHash: "h", toPath: "/nix/store/b", bytes });
    const deltas = [delta("/nix/store/old", 9), delta("/nix/store/older", 5), delta("/nix/store/gone", 1)];
    const local = new Map([
      ["/nix/store/old", { narHash: "h" }],
      ["/nix/store/older", { narHash: "h" }],
      ["/nix/store/gone", { narHash: "other" }],
    ]);
    const invalid = new Set(["/nix/store/b"]);
    const [step, ...rest] = planFetch({ closure, narinfos, deltas, invalid, local });
    assert.deepEqual([step.entry.path, step.delta.fromPath, rest.length], ["/nix/store/b", "/nix/store/older", 0]);
    const [range] = planFetch({ closure, narinfos, deltas, invalid, local: new Map() });
    assert.equal(range.narinfo.url, "nar/b");
    // A delta no smaller than the compressed NAR is never worth it.
    narinfos.get("/nix/store/b").info.fileSize = 5;
    assert.equal(planFetch({ closure, narinfos, deltas, invalid, local })[0].narinfo.url, "nar/b");
    // Neither local query may reach a substituter.
    assert.deepEqual(invalidPathsArgs(["/nix/store/a"]).slice(0, 2), ["--check-validity", "--print-invalid"]);
    const infoArgs = pathInfoArgs(["/nix/store/a"]);
    assert.equal(infoArgs[infoArgs.indexOf("substituters") + 1], "");
  });

  it("accepts a range only as an exact 206 of the requested length", async () => {
    const directory = await temporaryDirectory();
    const fetchWith = (status, contentRange, body) => () =>
      new Response(body, { status, headers: contentRange ? { "content-range": contentRange } : {} });
    const member = { offset: 512, size: 4, total: 2048 };
    let file = 0;
    const attempt = (fetchImpl) =>
      fetchRange("https://github.com/x", member, join(directory, String((file += 1))), { fetchImpl });
    await attempt(fetchWith(206, "bytes 512-515/2048", "abcd"));
    await assert.rejects(attempt(fetchWith(200, null, "abcd")), /HTTP 200/);
    await assert.rejects(attempt(fetchWith(206, "bytes 512-515/4096", "abcd")), /HTTP 206/);
    await assert.rejects(attempt(fetchWith(206, "bytes 512-515/2048", "abcdef")), /exceeds/);
    await assert.rejects(attempt(fetchWith(206, "bytes 512-515/2048", "ab")), /truncated/);
  });

  it("builds the cache from a delta or one tar range, and falls back on a corrupt sidecar", async () => {
    const directory = await temporaryDirectory();
    const release = await deltaRelease(directory);
    const { server, requests, fetchImpl } = await serveRelease(release.files);
    const index = `${release.artifact.name.replace(/\.tar$/, "")}.index.json`;
    const prepare = (name, baseNar) =>
      prepareIndexedCache({
        tag: "paseo-v1.2.3",
        artifact: release.artifact,
        closure: release.closure,
        directory: join(directory, name),
        downloadUrl: releaseDownloadUrl,
        fetchBytes: async (url) => {
          const response = await fetchImpl(url, {});
          assert.equal(response.status, 200);
          return Buffer.from(await response.arrayBuffer());
        },
        freeSpace: async () => {},
        fetchImpl,
        store: {
          invalidPaths: (paths) => new Set(paths.filter((path) => path !== release.paths.dep && path !== release.paths.base)),
          pathInfo: (paths) =>
            new Map(paths.map((path) => [path, { narHash: sri(baseNar), narSize: baseNar.length }])),
          dumpPath: (_path, file) => writeFile(file, baseNar, { flag: "wx" }),
        },
      });
    try {
      const viaDelta = await prepare("delta", release.nars.base);
      assert.deepEqual(requests.splice(0), [index, release.deltaName]);
      const hash = nix32(sha256(release.nars.desktop));
      assert.deepEqual(await readFile(join(viaDelta.cache, "nar", `${hash}.nar`)), release.nars.desktop);
      const rewritten = await readFile(join(viaDelta.cache, `${"b".repeat(32)}.narinfo`), "utf8");
      assert.match(rewritten, /^Compression: none$/m);
      assert.equal(
        narinfoFingerprint(parseNarinfo(rewritten)),
        narinfoFingerprint(parseNarinfo(release.narinfos.desktop)),
      );
      assert.equal(
        await readFile(join(viaDelta.cache, `${"a".repeat(32)}.narinfo`), "utf8"),
        release.narinfos.dep,
      );

      // A different installed base skips the delta and fetches one exact range.
      const viaRange = await prepare("range", Buffer.from("another base"));
      const member = release.index.members.find(
        (entry) => entry.name === parseNarinfo(release.narinfos.desktop).url,
      );
      assert.deepEqual(requests.splice(0), [
        index,
        `${release.artifact.name} bytes=${member.offset}-${member.offset + member.size - 1}`,
      ]);
      assert.equal((await readdir(join(viaRange.cache, "nar"))).length, 1);

      // A corrupt delta that its (unsigned) index entry vouches for: the real
      // zstd or the signed NarHash check rejects it, and the full download runs.
      const corrupt = Buffer.from(release.files[release.deltaName]);
      corrupt[corrupt.length >> 1] ^= 0xff;
      release.files[release.deltaName] = corrupt;
      const entry = release.index.deltas[0];
      Object.assign(entry, { bytes: corrupt.length, sha256: sha256(corrupt).toString("hex") });
      release.files[index] = Buffer.from(JSON.stringify(release.index));
      const warnings = [];
      const fallback = (fast) =>
        importWithFallback({ fast, full: async () => "full", warn: (message) => warnings.push(message) });
      assert.equal(await fallback(() => prepare("corrupt-delta", release.nars.base).then(() => "fast")), "full");
      assert.match(warnings[0], /zstd failed|signed NarHash/);
      release.files[index] = Buffer.from("{not json");
      assert.equal(await fallback(() => prepare("corrupt-index", release.nars.base).then(() => "fast")), "full");
      assert.equal(warnings.length, 2);
      assert.match(warnings[1], /JSON/);
    } finally {
      server.close();
    }
  });
});
