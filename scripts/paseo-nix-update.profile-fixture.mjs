#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, rm, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { setProfile } from "./paseo-nix-update.mjs";

const outputs = [
  "/nix/store/3vd5kgvc7l4hcg5mlr21f09inywmfnd6-nodejs-slim-26.11.0",
  "/nix/store/bgcnlqy8rr1g3hcrvrkfwbqz329wwh6n-nodejs-26.11.0",
];

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function profileOutput(profile) {
  return realpath(profile);
}

const parent = await mkdtemp(join(tmpdir(), "paseo-nix-profile-fixture-"));
const profile = join(parent, "profile");

try {
  for (const output of outputs) {
    assert.equal(
      command("nix", ["path-info", output]),
      output,
      `${output} must already be valid in the store`,
    );
    await lstat(join(output, "bin", "node"));
  }

  setProfile(profile, outputs[0], { fixture: true });
  assert.equal(await profileOutput(profile), outputs[0]);
  const generationOne = join(parent, `${basename(profile)}-1-link`);
  assert.equal(
    await realpath(join(generationOne, "bin", "node")),
    await realpath(join(outputs[0], "bin", "node")),
  );

  setProfile(profile, outputs[1], { fixture: true });
  assert.equal(await profileOutput(profile), outputs[1]);
  assert.equal(
    await realpath(join(profile, "bin", "node")),
    await realpath(join(outputs[1], "bin", "node")),
  );
  assert.equal(
    await realpath(join(generationOne, "bin", "node")),
    await realpath(join(outputs[0], "bin", "node")),
  );

  command("nix-env", ["--rollback", "--profile", profile]);
  assert.equal(await profileOutput(profile), outputs[0]);
  assert.equal(
    await realpath(join(profile, "bin", "node")),
    await realpath(join(outputs[0], "bin", "node")),
  );
  process.stdout.write(
    "PASS: nix-env --set replaces one profile generation, retains the previous root, and rollback restores it.\n",
  );
} finally {
  // Remove only this fixture's temporary profile-generation symlinks. The
  // store paths are left untouched and no garbage collection is run.
  await rm(parent, { recursive: true, force: true });
}
