import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./rebase-preflight.mjs";
import { parseReleaseTags, releaseBoundary } from "./rebase-dev.mjs";

const PRODUCTION_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEScQeKzAdwWjNsrJ7xQNq2BAKGSkXP6FPbBD7PZrM9J";
const CONFIG = "release-please-config.json";
const GENERATED = new Set([
  "chore(rebase): adapt incorporated upstream to the fork",
  "chore(rebase): capture incorporated upstream",
  "chore(rebase): point release-please at the rebased release",
]);

function parseCommit(raw) {
  const split = raw.indexOf(Buffer.from("\n\n"));
  assert.ok(split > 0, "Malformed commit");
  const headers = raw.subarray(0, split).toString("utf8").split("\n");
  const values = (name) =>
    headers
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => line.slice(name.length + 1));
  return {
    tree: values("tree")[0],
    parents: values("parent"),
    author: values("author")[0],
    committer: values("committer")[0],
    encoding: values("encoding"),
    message: raw.subarray(split + 2),
  };
}

export function comparePublication({
  original,
  clean,
  published,
  originalBoundary,
  cleanConfig,
  publishedConfig,
  finalPaths,
  cleanConfigMode,
  publishedConfigMode,
}) {
  assert.ok(clean.length > 0, "Empty replay");
  assert.equal(published.length, clean.length, "Commit count differs");
  const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value));
  assert.equal(cleanConfigMode, publishedConfigMode, "Final config mode differs");
  const matches = clean.flatMap((entry, index) =>
    entry.author === originalBoundary.author &&
    bytes(entry.message).equals(bytes(originalBoundary.message))
      ? [index]
      : [],
  );
  assert.equal(matches.length, 1, "Original release boundary must map uniquely into replay");
  const boundary = matches[0];
  assert.ok(
    original.some((entry) => entry.sha === originalBoundary.sha),
    "Boundary missing from backup",
  );
  const messages = [...GENERATED].map((message) => Buffer.from(`${message}\n`));
  let generatedStart = clean.length;
  let nextKind = messages.length;
  for (let index = clean.length - 1; index >= 0; index--) {
    const kind = messages.findIndex((message) => bytes(clean[index].message).equals(message));
    if (kind < 0 || kind >= nextKind) break;
    generatedStart = index;
    nextKind = kind;
  }
  for (let index = 0; index < clean.length; index++) {
    const a = clean[index];
    const b = published[index];
    assert.deepEqual(bytes(a.message), bytes(b.message), `Message differs at slot ${index + 1}`);
    const isGenerated = index >= generatedStart;
    if (isGenerated) {
      const identity = (value) => value.replace(/ \d+ [+-]\d{4}$/, "");
      assert.equal(identity(a.author), "Clement Liaw <cman101202@gmail.com>");
      assert.equal(identity(a.committer), "Clement Liaw <cman101202@gmail.com>");
      assert.equal(identity(a.author), identity(b.author));
      assert.equal(identity(a.committer), identity(b.committer));
      assert.deepEqual(a.encoding, b.encoding);
    } else {
      assert.equal(a.author, b.author, `Author differs at slot ${index + 1}`);
      assert.equal(a.committer, b.committer, `Committer differs at slot ${index + 1}`);
      assert.deepEqual(a.encoding, b.encoding);
    }
    if (index < clean.length - 1) assert.equal(a.tree, b.tree, `Tree differs at slot ${index + 1}`);
  }
  const cleanBytes = bytes(cleanConfig);
  const publishedBytes = bytes(publishedConfig);
  const a = JSON.parse(cleanBytes.toString("utf8"))["last-release-sha"];
  const b = JSON.parse(publishedBytes.toString("utf8"))["last-release-sha"];
  assert.equal(a, clean[boundary].sha, "Clean release boundary mismatch");
  assert.equal(b, published[boundary].sha, "Published release boundary mismatch");
  if (cleanBytes.equals(publishedBytes)) assert.deepEqual(finalPaths, []);
  else {
    assert.deepEqual(finalPaths, [CONFIG], "Unexpected final paths");
    const offset = cleanBytes.indexOf(a);
    assert.ok(
      offset >= 0 && cleanBytes.indexOf(a, offset + a.length) === -1,
      "Boundary must occur exactly once",
    );
    assert.deepEqual(
      Buffer.concat([
        cleanBytes.subarray(0, offset),
        Buffer.from(b),
        cleanBytes.subarray(offset + a.length),
      ]),
      publishedBytes,
      "Final config differs beyond last-release-sha",
    );
  }
  return {
    count: clean.length,
    boundarySlot: boundary + 1,
    boundaryOriginal: originalBoundary.sha,
    boundaryPublished: b,
  };
}

export function verifyPublication({
  backup,
  published,
  replay,
  repositoryPath = process.cwd(),
  run = command,
  publicKey = PRODUCTION_KEY,
} = {}) {
  assert.match(
    backup ?? "",
    /^refs\/heads\/backup\/rebase-dev\/[0-9]+-[0-9]+$/,
    "Expected a production backup ref",
  );
  for (const value of [published, replay])
    assert.match(value ?? "", /^[a-f0-9]{40}$/, "Use immutable full published/replay SHAs");
  const invoke = (file, args) => run(file, args, { cwd: repositoryPath });
  const git = (...args) => invoke("git", args).trimEnd();
  const backupSha = git("ls-remote", "origin", backup).split(/\s/)[0];
  assert.match(backupSha, /^[a-f0-9]{40}$/, "Backup missing");
  git("fetch", "--no-tags", "origin", backup, published, replay);
  const fork = (sha) => JSON.parse(git("show", `${sha}:.github/fork-release.json`));
  const upstream = fork(replay).upstreamBase;
  assert.match(upstream, /^[a-f0-9]{40}$/);
  assert.equal(fork(published).upstreamBase, upstream, "Published upstream differs from replay");
  git("merge-base", "--is-ancestor", fork(backupSha).upstreamBase, upstream);
  const entries = (end) =>
    git("rev-list", "--reverse", "--topo-order", `${upstream}..${end}`)
      .split("\n")
      .filter(Boolean)
      .map((sha) =>
        Object.assign(
          parseCommit(
            run("git", ["cat-file", "commit", sha], { cwd: repositoryPath, encoding: null }),
          ),
          { sha },
        ),
      );
  const original = entries(backupSha);
  const clean = entries(replay);
  const production = entries(published);
  for (const chain of [clean, production]) {
    let parent = upstream;
    for (const commit of chain) {
      assert.deepEqual(commit.parents, [parent], `Nonlinear replay at ${commit.sha}`);
      parent = commit.sha;
    }
  }
  const tags = parseReleaseTags(git("ls-remote", "--tags", "origin", "refs/tags/paseo-v*"));
  const backupConfig = JSON.parse(git("show", `${backupSha}:${CONFIG}`));
  tags.add(backupConfig["last-release-sha"]);
  const boundary = releaseBoundary(
    original.map((row) => row.sha),
    original.map((row) => row.sha),
    tags,
  );
  assert.ok(boundary, "No release boundary in backup history");
  const comparison = comparePublication({
    original,
    clean,
    published: production,
    originalBoundary: original.find((row) => row.sha === boundary.original),
    cleanConfig: run("git", ["show", `${replay}:${CONFIG}`], {
      cwd: repositoryPath,
      encoding: null,
    }),
    publishedConfig: run("git", ["show", `${published}:${CONFIG}`], {
      cwd: repositoryPath,
      encoding: null,
    }),
    cleanConfigMode: git("ls-tree", replay, "--", CONFIG).split(" ")[0],
    publishedConfigMode: git("ls-tree", published, "--", CONFIG).split(" ")[0],
    finalPaths: git("diff", "--name-only", replay, published).split("\n").filter(Boolean),
  });
  const directory = mkdtempSync(join(tmpdir(), "paseo-publication-"));
  try {
    const allowed = join(directory, "allowed-signers");
    writeFileSync(allowed, `* ${publicKey}\n`);
    for (const row of production)
      git(
        "-c",
        "gpg.format=ssh",
        "-c",
        `gpg.ssh.allowedSignersFile=${allowed}`,
        "verify-commit",
        row.sha,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const pages = JSON.parse(
    invoke("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/iExalt/paseo/compare/${upstream}...${published}?per_page=100`,
    ]),
  );
  const github = pages.flatMap((page) => page.commits);
  assert.equal(github.length, production.length, "GitHub commit count differs");
  assert.deepEqual(
    github.map((row) => row.sha).sort(),
    production.map((row) => row.sha).sort(),
    "GitHub SHA set differs",
  );
  for (const row of github)
    assert.equal(row.commit.verification.verified, true, `GitHub unverified: ${row.sha}`);
  return {
    ok: true,
    backup,
    backupSha,
    upstream,
    published,
    replay,
    ...comparison,
    pinnedSignatures: production.length,
    githubVerified: github.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        verifyPublication({
          backup: process.argv[2],
          published: process.argv[3],
          replay: process.argv[4],
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
