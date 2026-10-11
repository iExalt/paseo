import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// This is a launch authorization receipt, never a substitute for the monitor's
// final zero-active-process receipt. Production callers use current process facts.
export function verifyWindowsJob({
  platform = process.platform,
  pid = process.pid,
  executable = process.execPath,
  argv = process.argv.slice(1),
  env = process.env,
} = {}) {
  assert.equal(platform, "win32");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^\d+$/);
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  const root = join(
    env.RUNNER_TEMP,
    `paseo-windows-products-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
  const filename = env.PASEO_WINDOWS_JOB_START;
  assert.ok(filename, "Outer Windows Job monitor required");
  const read = (target) => {
    const stat = lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Regular owned receipt/spec required");
    return readFileSync(target);
  };
  const receipt = JSON.parse(read(filename));
  const { identity } = receipt;
  const stage = basename(identity.specification).replace(/-spec\.json$/, "");
  assert.match(stage, /^[a-z]+(?:-[a-z]+)*$/);
  assert.equal(resolve(identity.specification), resolve(root, `${stage}-spec.json`));
  assert.equal(resolve(filename), resolve(root, `${stage}-start.json`));
  const bytes = read(identity.specification);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), identity.specificationSha256);
  assert.equal(identity.sourceSha, env.GITHUB_SHA);
  assert.equal(identity.runId, env.GITHUB_RUN_ID);
  assert.equal(identity.attempt, env.GITHUB_RUN_ATTEMPT);
  assert.equal(receipt.primaryPid, pid, "Receipt must authorize this primary process");
  assert.ok(
    Number.isSafeInteger(receipt.monitorPid) &&
      receipt.monitorPid > 0 &&
      receipt.monitorPid !== pid,
  );
  assert.equal(receipt.killOnClose, true);
  assert.equal(receipt.breakaway, false);
  const spec = JSON.parse(bytes);
  assert.equal(resolve(spec.startReceipt), resolve(filename));
  assert.equal(realpathSync(spec.executable).toLowerCase(), realpathSync(executable).toLowerCase());
  assert.deepEqual(spec.arguments, argv);
  assert.equal(resolve(spec.directory), resolve(env.GITHUB_WORKSPACE));
  return { stage, primaryPid: pid, monitorPid: receipt.monitorPid };
}
