import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const remote = "https://github.com/iExalt/paseo.git";
const shaPattern = /^[a-f0-9]{40}$/;
export function proposalRef(branch) {
  assert.ok(["dev", "ci/release-please-rehearsal"].includes(branch));
  return `refs/heads/release-please--branches--${branch}--components--paseo`;
}
const execute = (args, options) => execFileSync("git", args, options).trim();
const safeGit = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "commit.gpgsign=false",
];

// Build one deterministic commit from frozen data without checking it out or
// invoking filters, hooks, dependency scripts, or release-engine updaters.
export async function proposalCommit({ cwd, base, files, title, identity }) {
  assert.match(base, shaPattern);
  assert.match(title, /^chore\(dev\): (release|replace pending release) [0-9]+\.[0-9]+\.[0-9]+$/);
  assert.ok(files instanceof Map && files.size > 0);
  assert.match(identity.botLogin, /^[a-z0-9-]+\[bot\]$/);
  assert.ok(Number.isSafeInteger(identity.botId) && identity.botId > 0);
  const directory = await mkdtemp(join(tmpdir(), "paseo-proposal-index-"));
  try {
    const date = execute(["show", "-s", "--format=%cI", base], { cwd, encoding: "utf8" });
    const email = `${identity.botId}+${identity.botLogin}@users.noreply.github.com`;
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(directory, "index"),
      GIT_AUTHOR_NAME: identity.botLogin,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: identity.botLogin,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: date,
    };
    const git = (args, input) =>
      execute([...safeGit, ...args], { cwd, env, input, encoding: "utf8" });
    git(["read-tree", base]);
    for (const [file, bytes] of files) {
      assert.match(file, /^[.a-zA-Z0-9_-]+(?:\/[.a-zA-Z0-9_-]+)*$/);
      assert.ok(!file.split("/").some((part) => [".", "..", ".git"].includes(part)));
      assert.equal(typeof bytes, "string");
      const existing = git(["ls-tree", base, "--", file]);
      const mode = existing ? existing.split(" ")[0] : "100644";
      assert.ok(["100644", "100755"].includes(mode), "Proposal cannot replace a symlink or tree");
      const blob = git(["hash-object", "-w", "--stdin"], bytes);
      git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`]);
    }
    const tree = git(["write-tree"]);
    assert.notEqual(tree, git(["rev-parse", `${base}^{tree}`]), "Proposal must change the tree");
    const sha = git(["commit-tree", tree, "-p", base], `${title}\n`);
    assert.equal(git(["show", "-s", "--format=%P", sha]), base);
    assert.equal(git(["rev-parse", `${sha}^{tree}`]), tree);
    return { sha, tree, base };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The expected head is captured before preparation. A rejected lease is final;
// callers must reconcile ambiguity, never silently refresh and retry the lease.
export async function pushProposal({ cwd, branch, expectedHead, sha, token, run = execute }) {
  const ref = proposalRef(branch);
  assert.match(sha, shaPattern);
  assert.ok(expectedHead === "" || shaPattern.test(expectedHead));
  assert.ok(typeof token === "string" && token.length > 0);
  const directory = await mkdtemp(join(tmpdir(), "paseo-proposal-auth-"));
  const askpass = join(directory, "askpass");
  try {
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *Password*) printf "%s\\n" "$RELEASE_APP_TOKEN" ;; *) exit 1 ;; esac\n',
      { mode: 0o700 },
    );
    return run(
      [
        ...safeGit,
        "push",
        "--porcelain",
        `--force-with-lease=${ref}:${expectedHead}`,
        remote,
        `${sha}:${ref}`,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          RELEASE_APP_TOKEN: token,
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
