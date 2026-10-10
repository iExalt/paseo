import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  exportResolutions,
  importResolutions,
  parseDeletionResolutions,
  publishRebase,
  rebaseDev,
  validateRebase,
} from "./rebase-dev.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Rebase fixture";
process.env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
process.env.GIT_COMMITTER_NAME = "Rebase fixture";
process.env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";

const root = mkdtempSync(join(tmpdir(), "paseo-rebase-dev-test-"));
const cleanup = () => rmSync(root, { recursive: true, force: true });
test.after(cleanup);
const testSigningKeyPath = join(root, "fixture-signing-key");
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", testSigningKeyPath]);
const testSigningKey = readFileSync(testSigningKeyPath, "utf8");
const testSigningPublicKey = readFileSync(`${testSigningKeyPath}.pub`, "utf8").trim();
const wrongSigningKeyPath = join(root, "wrong-fixture-signing-key");
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", wrongSigningKeyPath]);
const wrongSigningKey = readFileSync(wrongSigningKeyPath, "utf8");
const signingOptions = { signingKey: testSigningKey, publicKey: testSigningPublicKey };

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "advice.defaultBranchName=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    },
  ).trimEnd();
}

function gitWithEnv(cwd, extraEnv, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "advice.defaultBranchName=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", ...extraEnv },
    },
  ).trimEnd();
}

function commit(cwd, message, metadata = {}) {
  git(cwd, "add", "-A");
  gitWithEnv(cwd, metadata, "commit", "-m", message);
}

function devMetadata(authorName, authorEmail, authorDate, committerName, committerDate) {
  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: "clliaw@nvidia.com",
    GIT_COMMITTER_DATE: committerDate,
  };
}

function content({ target = "base target", far = "base far", marker = "base marker" } = {}) {
  return (
    [
      marker,
      ...Array.from({ length: 12 }, (_, index) => `context ${index}`),
      target,
      ...Array.from({ length: 12 }, (_, index) => `tail ${index}`),
      far,
    ].join("\n") + "\n"
  );
}

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Rebase fixture");
  git(path, "config", "user.email", "fixture@example.invalid");
  git(path, "config", "commit.gpgsign", "false");
}

async function makeFixture(
  name,
  {
    unknown = false,
    adaptedContext = false,
    initiallyEmpty = false,
    newlyEmpty = false,
    deletion = false,
  } = {},
) {
  const directory = join(root, name);
  const remote = join(directory, "origin.git");
  const seed = join(directory, "seed");
  const recorder = join(directory, "recorder");
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--bare", remote);

  initRepo(seed);
  writeFileSync(join(seed, "shared.txt"), content());
  if (deletion) writeFileSync(join(seed, "old.patch"), content());
  commit(seed, "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "HEAD:refs/heads/dev");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/dev");

  git(seed, "checkout", "-b", "upstream/main");
  writeFileSync(join(seed, "shared.txt"), content({ target: "upstream target" }));
  if (deletion) git(seed, "rm", "old.patch");
  commit(seed, "upstream target edit");
  git(seed, "push", "origin", "HEAD:refs/heads/upstream/main");
  let upstreamSha = git(seed, "rev-parse", "HEAD");

  git(seed, "checkout", "dev");
  if (initiallyEmpty) {
    gitWithEnv(
      seed,
      devMetadata(
        "Empty Author",
        "empty@example.invalid",
        "1700000100 -0700",
        "Clement Liaw",
        "1700000101 +0545",
      ),
      "commit",
      "--allow-empty",
      "-m",
      "originally empty dev commit\n\nkept as an original empty commit\n",
    );
  }
  writeFileSync(join(seed, "shared.txt"), content({ target: "dev target" }));
  if (deletion) {
    git(seed, "mv", "old.patch", "renamed.patch");
    writeFileSync(join(seed, "renamed.patch"), content({ target: "updated patch" }));
  }
  commit(
    seed,
    "dev target edit\n\nconflicting replay body\nwith second line\n",
    devMetadata(
      "Zoë Author",
      "zoe@example.invalid",
      "1700000300 +0930",
      "Clement Liaw",
      "1700000301 -0330",
    ),
  );
  if (unknown) {
    writeFileSync(join(seed, "shared.txt"), content({ target: "dev target", far: "dev far" }));
    commit(
      seed,
      "dev unknown edit",
      devMetadata(
        "Unknown Author",
        "unknown@example.invalid",
        "1700000400 +0000",
        "Clement Liaw",
        "1700000401 +0000",
      ),
    );
  }
  git(seed, "push", "origin", "HEAD:refs/heads/dev");
  const devSha = git(seed, "rev-parse", "HEAD");

  // Record one completed rerere pair by manually resolving the original conflict.
  git(directory, "clone", "--branch", "dev", remote, recorder);
  git(recorder, "config", "user.name", "Rebase fixture");
  git(recorder, "config", "user.email", "fixture@example.invalid");
  git(recorder, "config", "commit.gpgsign", "false");
  git(
    recorder,
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoupdate=true",
    "fetch",
    "origin",
    "refs/heads/upstream/main:refs/remotes/origin/upstream/main",
  );
  const initialRebase = spawnSync(
    "git",
    [
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoupdate=true",
      "rebase",
      "--merge",
      "--keep-empty",
      "--empty=stop",
      "refs/remotes/origin/upstream/main",
    ],
    {
      cwd: recorder,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.notEqual(initialRebase.status, 0, "fixture must record a real rebase conflict");
  let deletionRecord;
  if (deletion) {
    const stages = git(recorder, "ls-files", "-u", "--", "renamed.patch")
      .split("\n")
      .map((line) => {
        const [mode, oid, stage] = line.split(/\s+/);
        return { mode, oid, stage: Number(stage) };
      });
    deletionRecord = { upstream: upstreamSha, commit: devSha, path: "renamed.patch", stages };
    git(recorder, "rm", "renamed.patch");
  }
  const resolution = content({ target: "resolved target" });
  writeFileSync(join(recorder, "shared.txt"), resolution);
  git(recorder, "add", "shared.txt");
  git(recorder, "-c", "core.editor=true", "rebase", "--continue");

  const cache = join(recorder, ".git", "rr-cache");
  const ids = readdirSync(cache).filter((entry) => /^[0-9a-f]{40}$/.test(entry));
  assert.equal(ids.length, 1, "fixture should record one rerere id");
  const id = ids[0];
  const resolverPath = join(directory, "resolver");
  initRepo(resolverPath);
  git(resolverPath, "checkout", "-b", "rebase-resolutions");
  writeFileSync(join(cache, id, "thisimage"), "active resolution state must not export\n");
  const activeId = "a".repeat(40);
  mkdirSync(join(cache, activeId), { recursive: true });
  writeFileSync(join(cache, activeId, "preimage"), "unfinished preimage\n");
  writeFileSync(join(cache, activeId, "thisimage"), "unfinished active state\n");
  const exportedPairs = await exportResolutions({
    repositoryPath: recorder,
    destinationPath: resolverPath,
  });
  assert.ok(exportedPairs > 0, "export helper should preserve the completed rerere pair");
  assert.equal(existsSync(join(resolverPath, "resolutions", activeId)), false);
  assert.equal(existsSync(join(resolverPath, "resolutions", id, "thisimage")), false);
  if (deletionRecord)
    writeFileSync(join(resolverPath, "deletions.json"), JSON.stringify([deletionRecord]) + "\n");
  commit(resolverPath, "seed completed rerere resolution");
  git(resolverPath, "remote", "add", "origin", remote);
  git(resolverPath, "push", "origin", "HEAD:refs/heads/rebase-resolutions");

  if (adaptedContext || unknown || newlyEmpty) {
    git(seed, "checkout", "upstream/main");
    writeFileSync(
      join(seed, "shared.txt"),
      content({ target: "upstream target", far: newlyEmpty ? "same far" : "upstream far" }),
    );
    commit(seed, "upstream changes unrelated context");
    git(seed, "push", "origin", "HEAD:refs/heads/upstream/main");
    upstreamSha = git(seed, "rev-parse", "HEAD");
  }
  if (newlyEmpty) {
    git(seed, "checkout", "dev");
    writeFileSync(join(seed, "shared.txt"), content({ target: "dev target", far: "same far" }));
    commit(
      seed,
      "dev patch now empty against upstream",
      devMetadata(
        "Emptying Author",
        "emptying@example.invalid",
        "1700000500 +0000",
        "Clement Liaw",
        "1700000501 +0000",
      ),
    );
    git(seed, "push", "origin", "HEAD:refs/heads/dev");
  }
  return { directory, remote, devSha, upstreamSha, resolverPath, recorder, id, deletionRecord };
}

test("exact rename/delete resolutions replay and mismatched blobs fail closed", async () => {
  const fixture = await makeFixture("deletion", { deletion: true });
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  await rebaseDev({ repositoryPath: clone, ...signingOptions });
  assert.equal(existsSync(join(clone, "renamed.patch")), false);
  assert.equal(git(clone, "ls-files", "-u"), "");

  const record = structuredClone(fixture.deletionRecord);
  record.stages[1].oid = "a".repeat(40);
  writeFileSync(join(fixture.resolverPath, "deletions.json"), JSON.stringify([record]));
  commit(fixture.resolverPath, "chore: record mismatched deletion fixture");
  git(fixture.resolverPath, "push", "origin", "HEAD:refs/heads/rebase-resolutions");
  const rejected = join(fixture.directory, "mismatch");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, rejected);
  const beforeRefs = git(rejected, "ls-remote", "--refs", "origin");
  await assert.rejects(
    rebaseDev({ repositoryPath: rejected, ...signingOptions }),
    /index mismatch/,
  );
  assert.equal(existsSync(join(rejected, "renamed.patch")), true);
  assert.match(git(rejected, "ls-files", "-u"), /renamed.patch/);
  assert.equal(git(rejected, "ls-remote", "--refs", "origin"), beforeRefs);
});

test("deletion records reject unsafe paths, modes, duplicate keys and non-deletion stages", () => {
  const record = {
    upstream: "a".repeat(40),
    commit: "b".repeat(40),
    path: "patches/example.patch",
    stages: [
      { mode: "100644", oid: "c".repeat(40), stage: 1 },
      { mode: "100644", oid: "d".repeat(40), stage: 3 },
    ],
  };
  assert.deepEqual(parseDeletionResolutions(JSON.stringify([record])), [record]);
  for (const path of ["../file", "/file", ".git/config", "a/../file", "a\nfile", "a\\file"]) {
    assert.throws(() => parseDeletionResolutions(JSON.stringify([{ ...record, path }])), /Invalid/);
  }
  for (const stages of [
    [],
    [...record.stages, { ...record.stages[1], stage: 2 }],
    record.stages.map((stage) => ({ ...stage, mode: "120000" })),
  ]) {
    assert.throws(
      () => parseDeletionResolutions(JSON.stringify([{ ...record, stages }])),
      /Invalid/,
    );
  }
  assert.throws(() => parseDeletionResolutions(JSON.stringify([record, record])), /Duplicate/);
});

test("workflow is manual, actor/repository/ref guarded, and gates publication on validation", () => {
  const workflow = yaml.load(
    readFileSync(new URL("../workflows/rebase-dev.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.rebase["timeout-minutes"], 45);
  assert.match(workflow.jobs.rebase.if, /github\.repository == 'iExalt\/paseo'/);
  assert.match(workflow.jobs.rebase.if, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(workflow.jobs.rebase.if, /github\.actor == 'iExalt'/);
  assert.deepEqual(workflow.jobs.rebase.permissions, { contents: "write" });
  const rebaseStep = workflow.jobs.rebase.steps.find((step) => step.id === "rebase");
  assert.equal(
    rebaseStep.env.PASEO_REBASE_SSH_SIGNING_KEY,
    "${{ secrets.PASEO_REBASE_SSH_SIGNING_KEY }}",
  );
  assert.equal("GIT_COMMITTER_NAME" in rebaseStep.env, false);
  assert.equal("GIT_COMMITTER_EMAIL" in rebaseStep.env, false);
  const steps = workflow.jobs.rebase.steps;
  const publishIndex = steps.findIndex(
    (step) => step.name === "Publish backup and rebased dev atomically",
  );
  const rebaseIndex = steps.indexOf(rebaseStep);
  const setupIndex = steps.findIndex((step) => step.name === "Configure pinned npm installation");
  const installIndex = steps.findIndex((step) => step.run === "time npm ci --prefer-offline");
  const validateIndex = steps.findIndex((step) => step.id === "validate");
  assert.ok(rebaseIndex < setupIndex && setupIndex < installIndex);
  assert.ok(installIndex < validateIndex && validateIndex < publishIndex);
  assert.equal(steps[validateIndex].run, "node .github/scripts/rebase-dev.mjs validate");
  assert.equal(steps[publishIndex].env.TESTED_SHA, "${{ steps.validate.outputs.tested-sha }}");
  assert.equal(steps[publishIndex].env.GH_TOKEN, "${{ github.token }}");
  assert.equal(steps[0].with["persist-credentials"], false);
  assert.equal(workflow.jobs.rebase["runs-on"], "ubuntu-24.04");
  for (const [index, step] of steps.entries()) {
    if (index !== rebaseIndex) assert.equal(step.env?.PASEO_REBASE_SSH_SIGNING_KEY, undefined);
    if (index !== publishIndex) assert.equal(step.env?.GH_TOKEN, undefined);
    assert.doesNotMatch(step.uses ?? "", /actions\/(?:cache|upload-artifact)/);
    assert.doesNotMatch(step.run ?? "", /npm run (?:build:server|typecheck|test)/);
  }
  assert.match(steps[publishIndex].run, /::add-mask::/);
  assert.match(steps[publishIndex].run, /GIT_CONFIG_COUNT=1/);
  assert.match(
    steps[publishIndex].run,
    /GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/,
  );
  const diagnostics = steps.at(-1);
  assert.equal(diagnostics.if, "failure()");
  assert.match(diagnostics.run, /head -c 16000/);
  assert.match(steps[publishIndex].run, /rebase-dev\.mjs publish/);
  const helper = readFileSync(new URL("./rebase-dev.mjs", import.meta.url), "utf8");
  assert.match(helper, /--reapply-cherry-picks/);
  assert.match(helper, /--empty=stop/);
});

test("resolution export and import preserve arbitrary Git blob bytes", async () => {
  const fixture = await makeFixture("binary-resolutions");
  const resolver = join(fixture.directory, "binary-resolver");
  const receiver = join(fixture.directory, "binary-receiver");
  initRepo(resolver);
  git(resolver, "checkout", "-b", "rebase-resolutions");

  const preimage = Buffer.from([0xff, 0x00, 0x80, 0xc3, 0x28]);
  const postimage = Buffer.from([0xfe, 0x00, 0x81, 0xe2, 0x82]);
  writeFileSync(join(fixture.recorder, ".git", "rr-cache", fixture.id, "preimage"), preimage);
  writeFileSync(join(fixture.recorder, ".git", "rr-cache", fixture.id, "postimage"), postimage);

  assert.equal(
    await exportResolutions({ repositoryPath: fixture.recorder, destinationPath: resolver }),
    1,
  );
  commit(resolver, "export binary resolution pair");
  initRepo(receiver);
  git(receiver, "remote", "add", "resolution", resolver);
  git(
    receiver,
    "fetch",
    "resolution",
    "refs/heads/rebase-resolutions:refs/remotes/resolution/rebase-resolutions",
  );
  const resolutionSha = git(receiver, "rev-parse", "refs/remotes/resolution/rebase-resolutions");

  assert.equal(await importResolutions(receiver, resolutionSha), 1);
  assert.deepEqual(
    readFileSync(join(receiver, ".git", "rr-cache", fixture.id, "preimage")),
    preimage,
  );
  assert.deepEqual(
    readFileSync(join(receiver, ".git", "rr-cache", fixture.id, "postimage")),
    postimage,
  );
});

test("known rerere resolution is imported and resumes while preserving adapted context", async () => {
  const fixture = await makeFixture("known", { adaptedContext: true, initiallyEmpty: true });
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  const beforeRefs = git(clone, "ls-remote", "--refs", "origin");

  await assert.rejects(
    rebaseDev({ repositoryPath: clone }),
    /PASEO_REBASE_SSH_SIGNING_KEY is required/,
  );
  await assert.rejects(
    rebaseDev({ repositoryPath: clone, ...signingOptions, signingKey: wrongSigningKey }),
    /does not match the trusted public key/,
  );
  assert.equal(git(clone, "ls-remote", "--refs", "origin"), beforeRefs);

  const snapshots = await rebaseDev({
    repositoryPath: clone,
    ...signingOptions,
    signingKey: testSigningKey.trimEnd(),
  });

  assert.equal(snapshots.dev, fixture.devSha);
  assert.equal(snapshots.upstream, fixture.upstreamSha);
  assert.equal(
    git(clone, "show", "HEAD:shared.txt"),
    content({ target: "resolved target", far: "upstream far" }).trimEnd(),
  );
  assert.equal(git(clone, "merge-base", "--is-ancestor", fixture.upstreamSha, "HEAD"), "");
  assert.match(
    git(clone, "log", "--format=%s", `${fixture.upstreamSha}..HEAD`),
    /originally empty dev commit/,
  );
  assert.match(git(clone, "status", "--porcelain"), /^$/);
  const originalCommits = git(
    clone,
    "rev-list",
    "--reverse",
    `${fixture.upstreamSha}..${fixture.devSha}`,
  ).split("\n");
  const rewrittenCommits = git(
    clone,
    "rev-list",
    "--reverse",
    `${fixture.upstreamSha}..HEAD`,
  ).split("\n");
  assert.equal(rewrittenCommits.length, originalCommits.length);
  const allowedSigners = join(fixture.directory, "allowed-signers");
  writeFileSync(
    allowedSigners,
    `clliaw@nvidia.com ${testSigningPublicKey.split(/\s+/).slice(0, 2).join(" ")}\n`,
  );
  for (let index = 0; index < originalCommits.length; index += 1) {
    const original = execFileSync("git", ["cat-file", "commit", originalCommits[index]], {
      cwd: clone,
      encoding: "buffer",
    });
    const rewritten = execFileSync("git", ["cat-file", "commit", rewrittenCommits[index]], {
      cwd: clone,
      encoding: "buffer",
    });
    const separator = Buffer.from("\n\n");
    const originalSeparator = original.indexOf(separator);
    const rewrittenSeparator = rewritten.indexOf(separator);
    const originalHeaders = original.subarray(0, originalSeparator).toString("utf8").split("\n");
    const rewrittenHeaders = rewritten.subarray(0, rewrittenSeparator).toString("utf8").split("\n");
    assert.equal(
      rewrittenHeaders.find((line) => line.startsWith("author ")),
      originalHeaders.find((line) => line.startsWith("author ")),
    );
    assert.equal(
      rewrittenHeaders.find((line) => line.startsWith("committer ")),
      originalHeaders.find((line) => line.startsWith("committer ")),
    );
    assert.deepEqual(
      rewritten.subarray(rewrittenSeparator + 2),
      original.subarray(originalSeparator + 2),
    );
    assert.match(rewrittenHeaders.join("\n"), /gpgsig -----BEGIN SSH SIGNATURE-----/);
    git(
      clone,
      "-c",
      "gpg.format=ssh",
      "-c",
      `gpg.ssh.allowedSignersFile=${allowedSigners}`,
      "verify-commit",
      rewrittenCommits[index],
    );
  }
  assert.ok(snapshots.signedCommits > 0);
});

test("unknown conflict stops without publishing any refs", async () => {
  const fixture = await makeFixture("unknown", { unknown: true });
  const clone = join(fixture.directory, "checkout");
  const diagnostics = join(fixture.directory, "diagnostics.txt");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  const beforeRefs = git(clone, "ls-remote", "--refs", "origin");

  await assert.rejects(
    rebaseDev({ repositoryPath: clone, diagnosticsPath: diagnostics, ...signingOptions }),
    /without a safely reusable completed resolution/,
  );

  const conflicts = git(clone, "ls-files", "-u");
  assert.match(conflicts, /shared\.txt/);
  assert.equal(git(clone, "ls-remote", "--refs", "origin"), beforeRefs);
  const diagnosticText = readFileSync(diagnostics, "utf8");
  assert.match(diagnosticText, /Starting refs:/);
  assert.match(diagnosticText, /diff --cc shared\.txt/);
});

test("a newly empty replay stops with rebase state intact", async () => {
  const fixture = await makeFixture("newly-empty", { newlyEmpty: true });
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  const beforeRefs = git(clone, "ls-remote", "--refs", "origin");

  await assert.rejects(
    rebaseDev({ repositoryPath: clone, ...signingOptions }),
    /without a safely reusable completed resolution/,
  );

  assert.ok(git(clone, "rev-parse", "-q", "--verify", "REBASE_HEAD"));
  assert.match(git(clone, "status"), /rebase in progress/);
  assert.equal(git(clone, "ls-remote", "--refs", "origin"), beforeRefs);
});

test("schema-only resolution branch imports and leaves an unknown conflict diagnosable", async () => {
  const fixture = await makeFixture("schema-only");
  git(fixture.resolverPath, "rm", "-r", "resolutions");
  commit(fixture.resolverPath, "initialize empty resolution cache");
  git(fixture.resolverPath, "push", "--force", "origin", "HEAD:refs/heads/rebase-resolutions");
  const clone = join(fixture.directory, "checkout");
  const diagnostics = join(fixture.directory, "diagnostics.txt");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);

  await assert.rejects(
    rebaseDev({ repositoryPath: clone, diagnosticsPath: diagnostics, ...signingOptions }),
    /without a safely reusable completed resolution/,
  );

  assert.match(readFileSync(diagnostics, "utf8"), /Starting refs:/);
  assert.match(readFileSync(diagnostics, "utf8"), /Conflict diff/);
  assert.notEqual(git(clone, "ls-files", "-u"), "");
});

test("export and import refuse symlinked rerere variants", async () => {
  const fixture = await makeFixture("symlink");
  const sourceVariant = join(fixture.recorder, ".git", "rr-cache", fixture.id, "preimage");
  const savedVariant = `${sourceVariant}.saved`;
  git(fixture.resolverPath, "checkout", "--detach");
  // Replace the completed source record with a symlink; the exporter must reject it before writing.
  const destination = join(fixture.directory, "unsafe-export");
  initRepo(destination);
  git(destination, "checkout", "-b", "rebase-resolutions");
  const variantContents = readFileSync(sourceVariant);
  unlinkSync(sourceVariant);
  writeFileSync(savedVariant, variantContents);
  symlinkSync(savedVariant, sourceVariant);
  await assert.rejects(
    exportResolutions({ repositoryPath: fixture.recorder, destinationPath: destination }),
    /not a regular file/,
  );
  assert.equal(existsSync(join(destination, "schema.json")), false);

  // A committed symlink is represented by mode 120000 and must fail import before rr-cache writes.
  git(fixture.resolverPath, "checkout", "rebase-resolutions");
  unlinkSync(join(fixture.resolverPath, "resolutions", fixture.id, "preimage"));
  symlinkSync("postimage", join(fixture.resolverPath, "resolutions", fixture.id, "preimage"));
  commit(fixture.resolverPath, "add invalid resolution symlink");
  git(fixture.resolverPath, "push", "--force", "origin", "HEAD:refs/heads/rebase-resolutions");
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  await assert.rejects(
    rebaseDev({ repositoryPath: clone, ...signingOptions }),
    /Unsupported path or file mode/,
  );
  assert.equal(existsSync(join(clone, ".git", "rr-cache", fixture.id)), false);
});

test("atomic publication saves captured dev and rejects a stale dev lease", async () => {
  const fixture = await makeFixture("publish");
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  await rebaseDev({ repositoryPath: clone, ...signingOptions });

  await assert.rejects(
    validateRebase({
      repositoryPath: clone,
      runChecks: async () => {
        throw new Error("fixture check failed");
      },
    }),
    /fixture check failed/,
  );
  assert.equal(git(fixture.remote, "rev-parse", "refs/heads/dev"), fixture.devSha);
  assert.equal(git(clone, "ls-remote", "--refs", "origin", "refs/heads/backup/rebase-dev/*"), "");
  const testedSha = await validateRebase({ repositoryPath: clone, runChecks: async () => {} });
  writeFileSync(join(clone, "unexpected.txt"), "untracked input");
  await assert.rejects(
    publishRebase({ repositoryPath: clone, devSha: fixture.devSha, testedSha, runId: "90000" }),
    /clean tracked and nonignored/,
  );
  unlinkSync(join(clone, "unexpected.txt"));
  const first = await publishRebase({
    repositoryPath: clone,
    devSha: fixture.devSha,
    testedSha,
    runId: "90001",
    runAttempt: "1",
  });
  assert.equal(git(fixture.remote, "rev-parse", first.backupRef), fixture.devSha);
  assert.equal(git(fixture.remote, "rev-parse", "refs/heads/dev"), first.rewritten);

  writeFileSync(join(clone, "after-publish.txt"), "make the second push non-empty\n");
  commit(clone, "local unpublished change");
  await assert.rejects(
    publishRebase({ repositoryPath: clone, devSha: fixture.devSha, testedSha, runId: "90002" }),
    /HEAD differs/,
  );

  await assert.rejects(
    publishRebase({
      repositoryPath: clone,
      devSha: fixture.devSha,
      testedSha: git(clone, "rev-parse", "HEAD"),
      runId: "90002",
      runAttempt: "1",
    }),
    /Atomic backup\/rebase push failed/,
  );
  assert.notEqual(git(fixture.remote, "rev-parse", "refs/heads/dev"), fixture.devSha);
  assert.equal(
    git(clone, "ls-remote", "--refs", "origin", "refs/heads/backup/rebase-dev/90002-1"),
    "",
  );
});

test("validation CLI binds the shared command to a clean tested SHA", async () => {
  const repositoryPath = join(root, "validation-checkout");
  const bin = join(root, "validation-bin");
  initRepo(repositoryPath);
  mkdirSync(bin);
  writeFileSync(join(repositoryPath, "tracked.txt"), "original\n");
  writeFileSync(join(repositoryPath, ".gitignore"), ".env*\n.dev.vars*\nnode_modules/\n");
  writeFileSync(join(repositoryPath, ".env.example"), "EXAMPLE=1\n");
  git(repositoryPath, "add", "-f", ".env.example");
  commit(repositoryPath, "validation fixture");
  const originalSha = git(repositoryPath, "rev-parse", "HEAD");
  const invocation = join(root, "validation-invocation.json");
  const output = join(root, "validation-output.txt");
  const fakeMise = join(bin, "mise");
  writeFileSync(
    fakeMise,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
fs.writeFileSync(process.env.FIXTURE_INVOCATION, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), sha: cp.execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim() }));
if (process.env.FIXTURE_MODE === "fail") process.exit(17);
if (process.env.FIXTURE_MODE === "dirty") fs.writeFileSync("tracked.txt", "changed");
if (process.env.FIXTURE_MODE === "override") fs.writeFileSync(".env.local", "LOCAL=1");
if (process.env.FIXTURE_MODE === "move") cp.execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "moved"]);
`,
  );
  chmodSync(fakeMise, 0o755);
  const invoke = (mode = "success") => {
    rmSync(output, { force: true });
    rmSync(invocation, { force: true });
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./rebase-dev.mjs", import.meta.url)), "validate"],
      {
        cwd: repositoryPath,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          FIXTURE_INVOCATION: invocation,
          FIXTURE_MODE: mode,
        },
      },
    );
  };
  assert.equal(invoke().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(invocation, "utf8")), {
    args: ["run", "--skip-tools", "ci:routine"],
    cwd: realpathSync(repositoryPath),
    sha: originalSha,
  });
  assert.equal(readFileSync(output, "utf8"), `tested-sha=${originalSha}\n`);
  for (const [mode, error] of [
    ["fail", /Routine verification failed \(17\)/],
    ["dirty", /clean tracked/],
    ["override", /Local environment override/],
    ["move", /HEAD differs/],
  ]) {
    const result = invoke(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
    assert.equal(existsSync(output), false);
    git(repositoryPath, "reset", "--hard", originalSha);
    rmSync(join(repositoryPath, ".env.local"), { force: true });
  }
  writeFileSync(join(repositoryPath, "tracked.txt"), "changed before checking");
  assert.match(invoke().stderr, /clean tracked/);
  assert.equal(existsSync(invocation), false);
  git(repositoryPath, "reset", "--hard", originalSha);
  writeFileSync(join(repositoryPath, "untracked.txt"), "input");
  assert.match(invoke().stderr, /clean tracked/);
  assert.equal(existsSync(invocation), false);
  unlinkSync(join(repositoryPath, "untracked.txt"));
  for (const [directory, name] of [
    ["", ".env.local"],
    ["packages/server", ".env"],
    ["plugins", ".dev.vars"],
  ]) {
    const location = join(repositoryPath, directory);
    mkdirSync(location, { recursive: true });
    const override = join(location, name);
    writeFileSync(override, "LOCAL=1\n");
    assert.match(invoke().stderr, /Local environment override/);
    assert.equal(existsSync(invocation), false);
    assert.equal(existsSync(override), true);
    unlinkSync(override);
  }
});
