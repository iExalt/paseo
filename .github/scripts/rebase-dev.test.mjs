import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { exportResolutions, importResolutions, publishRebase, rebaseDev } from "./rebase-dev.mjs";

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

function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
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
  { unknown = false, adaptedContext = false, initiallyEmpty = false, newlyEmpty = false } = {},
) {
  const directory = join(root, name);
  const remote = join(directory, "origin.git");
  const seed = join(directory, "seed");
  const recorder = join(directory, "recorder");
  const resolver = join(directory, "resolver");
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--bare", remote);

  initRepo(seed);
  writeFileSync(join(seed, "shared.txt"), content());
  commit(seed, "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "HEAD:refs/heads/dev");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/dev");

  git(seed, "checkout", "-b", "upstream/main");
  writeFileSync(join(seed, "shared.txt"), content({ target: "upstream target" }));
  commit(seed, "upstream target edit");
  git(seed, "push", "origin", "HEAD:refs/heads/upstream/main");
  let upstreamSha = git(seed, "rev-parse", "HEAD");

  git(seed, "checkout", "dev");
  if (initiallyEmpty) {
    git(seed, "commit", "--allow-empty", "-m", "originally empty dev commit");
  }
  writeFileSync(join(seed, "shared.txt"), content({ target: "dev target" }));
  commit(seed, "dev target edit");
  if (unknown) {
    writeFileSync(join(seed, "shared.txt"), content({ target: "dev target", far: "dev far" }));
    commit(seed, "dev unknown edit");
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
    commit(seed, "dev patch now empty against upstream");
    git(seed, "push", "origin", "HEAD:refs/heads/dev");
  }
  return { directory, remote, devSha, upstreamSha, resolverPath, recorder, id };
}

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
  assert.equal(rebaseStep.env.GIT_COMMITTER_NAME, "iExalt");
  assert.equal(rebaseStep.env.GIT_COMMITTER_EMAIL, "iExalt@users.noreply.github.com");
  const steps = workflow.jobs.rebase.steps;
  const publishIndex = steps.findIndex(
    (step) => step.name === "Publish backup and rebased dev atomically",
  );
  assert.ok(publishIndex > steps.findIndex((step) => step.name === "Typecheck all packages"));
  assert.ok(publishIndex > steps.findIndex((step) => step.name === "Run protocol tests"));
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

test("known rerere resolution is imported and resumes while preserving adapted context", async (t) => {
  const fixture = await makeFixture("known", { adaptedContext: true, initiallyEmpty: true });
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);

  const snapshots = await rebaseDev({ repositoryPath: clone });

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
});

test("unknown conflict stops without publishing any refs", async (t) => {
  const fixture = await makeFixture("unknown", { unknown: true });
  const clone = join(fixture.directory, "checkout");
  const diagnostics = join(fixture.directory, "diagnostics.txt");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  const beforeRefs = git(clone, "ls-remote", "--refs", "origin");

  await assert.rejects(
    rebaseDev({ repositoryPath: clone, diagnosticsPath: diagnostics }),
    /without a safely reusable completed resolution/,
  );

  const conflicts = git(clone, "ls-files", "-u");
  assert.match(conflicts, /shared\.txt/);
  assert.equal(git(clone, "ls-remote", "--refs", "origin"), beforeRefs);
  const diagnosticText = readFileSync(diagnostics, "utf8");
  assert.match(diagnosticText, /Starting refs:/);
  assert.match(diagnosticText, /diff --cc shared\.txt/);
});

test("a newly empty replay stops with rebase state intact", async (t) => {
  const fixture = await makeFixture("newly-empty", { newlyEmpty: true });
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  const beforeRefs = git(clone, "ls-remote", "--refs", "origin");

  await assert.rejects(
    rebaseDev({ repositoryPath: clone }),
    /without a safely reusable completed resolution/,
  );

  assert.ok(git(clone, "rev-parse", "-q", "--verify", "REBASE_HEAD"));
  assert.match(git(clone, "status"), /rebase in progress/);
  assert.equal(git(clone, "ls-remote", "--refs", "origin"), beforeRefs);
});

test("schema-only resolution branch imports and leaves an unknown conflict diagnosable", async (t) => {
  const fixture = await makeFixture("schema-only");
  git(fixture.resolverPath, "rm", "-r", "resolutions");
  commit(fixture.resolverPath, "initialize empty resolution cache");
  git(fixture.resolverPath, "push", "--force", "origin", "HEAD:refs/heads/rebase-resolutions");
  const clone = join(fixture.directory, "checkout");
  const diagnostics = join(fixture.directory, "diagnostics.txt");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);

  await assert.rejects(
    rebaseDev({ repositoryPath: clone, diagnosticsPath: diagnostics }),
    /without a safely reusable completed resolution/,
  );

  assert.match(readFileSync(diagnostics, "utf8"), /Starting refs:/);
  assert.match(readFileSync(diagnostics, "utf8"), /Conflict diff/);
  assert.notEqual(git(clone, "ls-files", "-u"), "");
});

test("export and import refuse symlinked rerere variants", async (t) => {
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
  await assert.rejects(rebaseDev({ repositoryPath: clone }), /Unsupported path or file mode/);
  assert.equal(existsSync(join(clone, ".git", "rr-cache", fixture.id)), false);
});

test("atomic publication saves captured dev and rejects a stale dev lease", async (t) => {
  const fixture = await makeFixture("publish");
  const clone = join(fixture.directory, "checkout");
  git(fixture.directory, "clone", "--branch", "dev", fixture.remote, clone);
  await rebaseDev({ repositoryPath: clone });

  const first = await publishRebase({
    repositoryPath: clone,
    devSha: fixture.devSha,
    runId: "90001",
    runAttempt: "1",
  });
  assert.equal(git(fixture.remote, "rev-parse", first.backupRef), fixture.devSha);
  assert.equal(git(fixture.remote, "rev-parse", "refs/heads/dev"), first.rewritten);

  writeFileSync(join(clone, "after-publish.txt"), "make the second push non-empty\n");
  commit(clone, "local unpublished change");

  await assert.rejects(
    publishRebase({
      repositoryPath: clone,
      devSha: fixture.devSha,
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
