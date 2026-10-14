import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export function windowsStorageRoot(env) {
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^\d+$/);
  assert.match(env.RUNNER_TEMP, /^C:\\/i);
  return win32.join(
    env.RUNNER_TEMP,
    `paseo-windows-storage-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
}

// Layout selection does not establish disk ownership or antivirus state. The
// storage controller independently checks those before writes and teardown.
export function windowsSourcePaths(env, owner) {
  assert.ok(["arm64", "x64"].includes(env.EXPECTED_ARCHITECTURE));
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^\d+$/);
  assert.match(env.GITHUB_WORKSPACE, /^[A-Z]:\\/i);
  assert.match(env.RUNNER_TEMP, /^[A-Z]:\\/i);
  const controller = win32.resolve(env.GITHUB_WORKSPACE);
  const productRoot = win32.join(
    env.RUNNER_TEMP,
    `paseo-windows-products-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
  if (env.EXPECTED_ARCHITECTURE === "x64") {
    assert.equal(owner, undefined, "Ordinary layout must not consume storage ownership");
    return {
      controller,
      candidate: controller,
      previous: win32.join(productRoot, "previous-source"),
    };
  }
  const storageRoot = windowsStorageRoot(env);
  assert.match(env.GITHUB_WORKSPACE, /^C:\\/i);
  const sourceSha = env.PASEO_CANDIDATE_SHA || env.GITHUB_SHA;
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok(owner, "ARM build storage ownership required");
  assert.equal(owner.schema, 1);
  assert.equal(owner.ready, true);
  assert.equal(owner.sourceSha, sourceSha);
  assert.equal(owner.runId, env.GITHUB_RUN_ID);
  assert.equal(owner.attempt, env.GITHUB_RUN_ATTEMPT);
  assert.equal(owner.architecture, "arm64");
  assert.equal(owner.controller, controller);
  assert.equal(owner.vhdPath, win32.join(storageRoot, "sources.vhdx"));
  assert.match(owner.diskIdentifier, /^[a-f0-9-]{36}$/i);
  assert.match(owner.volumeRoot, /^[D-Z]:\\$/);
  const candidate = win32.join(owner.volumeRoot, "paseo-candidate");
  const previous = win32.join(owner.volumeRoot, "paseo-previous");
  assert.equal(owner.candidate, candidate);
  assert.equal(owner.previous, previous);
  return { controller, candidate, previous };
}

export function loadWindowsSources({ env = process.env } = {}) {
  let owner;
  if (env.EXPECTED_ARCHITECTURE === "arm64") {
    const filename = win32.join(windowsStorageRoot(env), "owner.json");
    const info = lstatSync(filename);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "Regular storage ownership record required");
    owner = JSON.parse(readFileSync(filename, "utf8"));
  }
  return windowsSourcePaths(env, owner);
}
