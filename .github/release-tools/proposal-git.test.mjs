import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { proposalCommit, proposalRef, pushProposal } from "./proposal-git.mjs";

test("prepared proposal preserves checkout and enforces atomic existing and absent ref leases", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "paseo-proposal-test-"));
  const cwd = join(temporary, "source"),
    bare = join(temporary, "remote");
  const git = (args, options = {}) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    }).trim();
  try {
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    await writeFile(join(cwd, "data"), "base\n");
    git(["add", "data"]);
    git([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "chore: fixture",
    ]);
    const base = git(["rev-parse", "HEAD"]);
    const identity = { botLogin: "paseo-release[bot]", botId: 341220930 };
    const args = {
      cwd,
      base,
      files: new Map([["data", "prepared\n"]]),
      title: "chore(dev): release 0.1.0",
      identity,
    };
    const commit = await proposalCommit(args);
    assert.deepEqual(
      await proposalCommit(args),
      commit,
      "Prepared retries must produce identical commits",
    );
    assert.equal(git(["show", `${commit.sha}:data`]), "prepared");
    assert.equal(
      git(["show", "-s", "--format=%an|%ae", commit.sha]),
      "paseo-release[bot]|341220930+paseo-release[bot]@users.noreply.github.com",
    );
    assert.equal(git(["rev-parse", "HEAD"]), base);
    assert.equal(git(["status", "--porcelain"]), "");
    assert.equal(await readFile(join(cwd, "data"), "utf8"), "base\n");
    await assert.rejects(proposalCommit({ ...args, files: new Map([["../escape", "bad"]]) }));
    assert.throws(() => proposalRef("main"));
    const helpers = [];
    const run = (command, options) => {
      assert.ok(command.includes("https://github.com/iExalt/paseo.git"));
      assert.ok(!command.join(" ").includes("fixture-token"));
      helpers.push(options.env.GIT_ASKPASS);
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
      return git(
        command.map((value) => (value === "https://github.com/iExalt/paseo.git" ? bare : value)),
        options,
      );
    };
    const push = { cwd, branch: "dev", sha: commit.sha, token: "fixture-token", run };
    await pushProposal({ ...push, expectedHead: "" });
    // Simulate another writer changing the branch after the captured snapshot.
    const ref = proposalRef("dev");
    git(["--git-dir", bare, "update-ref", ref, base, commit.sha]);
    await assert.rejects(pushProposal({ ...push, expectedHead: commit.sha }));
    await assert.rejects(pushProposal({ ...push, expectedHead: "" }));
    assert.equal(git(["--git-dir", bare, "rev-parse", ref]), base);
    await pushProposal({ ...push, expectedHead: base });
    assert.equal(git(["--git-dir", bare, "rev-parse", ref]), commit.sha);
    for (const helper of helpers) await assert.rejects(readFile(helper), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
