import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mergeUpdates } from "release-please/build/src/updaters/composite.js";
import { inspectForkRelease } from "../../scripts/fork-release-config.mjs";

export const lockDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateNpmHash(value) {
  assert.match(value, /^sha256-[A-Za-z0-9+/]{43}=$/, "Expected pinned Nix dependency hash");
  return value;
}

// Materialize the engine's complete updates before fetching dependencies. The
// publisher receives data, never an updater that could mutate the lock later.
export async function composeProposalTree(proposal, read, prefetch) {
  const files = new Map();
  for (const update of mergeUpdates(proposal.updates)) {
    let before;
    try {
      before = await read(update.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!update.createIfMissing) continue;
    }
    const after = update.updater.updateContent(before);
    if (after) files.set(update.path, after);
  }
  assert.ok(files.has("package-lock.json"), "Version proposal must include its final lock");
  const lock = files.get("package-lock.json");
  const npmDepsHash = validateNpmHash(await prefetch(lock));
  files.set("nix/npm-deps.hash", `${npmDepsHash}\n`);
  const readFinal = async (file) => (files.has(file) ? files.get(file) : read(file));
  const { config } = await inspectForkRelease(readFinal);
  assert.equal(config.version, proposal.version.toString());
  return { files, lockSha256: lockDigest(lock), npmDepsHash };
}

export function verifyProposalLock(prepared) {
  assert.equal(lockDigest(prepared.files.get("package-lock.json")), prepared.lockSha256);
  assert.equal(
    prepared.files.get("nix/npm-deps.hash"),
    `${validateNpmHash(prepared.npmDepsHash)}\n`,
  );
}
