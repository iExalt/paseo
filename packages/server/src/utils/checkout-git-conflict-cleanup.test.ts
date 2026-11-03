import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MergeConflictError, mergeToBase, pullCurrentBranch } from "./checkout-git.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Keep the developer's git config (signing, hooks, pull.rebase) out of the result.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function tryGit(cwd: string, args: string[]): void {
  try {
    git(cwd, args);
  } catch {
    // Expected conflict exit.
  }
}

/** A repo on `feature` whose `file.txt` conflicts with `main`. */
function makeConflictingRepo(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-conflict-cleanup-")));
  tempDirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  // The code under test runs git itself: give the repo an identity (merge --squash needs one).
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature\n");
  git(dir, ["commit", "-q", "-am", "feature"]);
  git(dir, ["checkout", "-q", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["commit", "-q", "-am", "main"]);
  git(dir, ["checkout", "-q", "feature"]);
  return dir;
}

describe("checkout git conflict cleanup", () => {
  it("refuses to pull over a merge in progress instead of aborting it", async () => {
    const dir = makeConflictingRepo();
    git(dir, ["remote", "add", "origin", join(dir, "missing-origin")]);
    tryGit(dir, ["merge", "main"]);
    writeFileSync(join(dir, "file.txt"), "resolved\n");
    git(dir, ["add", "file.txt"]);

    await expect(pullCurrentBranch(dir)).rejects.toThrow("already in progress");

    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect(git(dir, ["show", ":file.txt"])).toBe("resolved\n");
  });

  it("leaves the checkout on its branch with no conflicts after a squash merge conflict", async () => {
    const dir = makeConflictingRepo();

    await expect(mergeToBase(dir, { baseRef: "main", mode: "squash" })).rejects.toBeInstanceOf(
      MergeConflictError,
    );

    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("feature\n");
  });
});
