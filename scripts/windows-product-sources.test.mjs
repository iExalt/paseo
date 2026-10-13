import assert from "node:assert/strict";
import test from "node:test";
import { windowsSourcePaths } from "../.github/scripts/windows-product-sources.mjs";

const env = {
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  RUNNER_TEMP: "C:\\runner\\temp",
  GITHUB_WORKSPACE: "C:\\runner\\source",
  EXPECTED_ARCHITECTURE: "arm64",
  GITHUB_SHA: "a".repeat(40),
  PASEO_CANDIDATE_SHA: "b".repeat(40),
};
const owner = {
  schema: 1,
  ready: true,
  sourceSha: env.PASEO_CANDIDATE_SHA,
  runId: "123",
  attempt: "2",
  architecture: "arm64",
  controller: env.GITHUB_WORKSPACE,
  vhdPath: "C:\\runner\\temp\\paseo-windows-storage-123-2\\sources.vhdx",
  diskIdentifier: "01234567-89ab-cdef-0123-456789abcdef",
  volumeRoot: "D:\\",
  candidate: "D:\\paseo-candidate",
  previous: "D:\\paseo-previous",
};

test("ARM source layout requires exact current-run storage ownership without fallback", () => {
  assert.deepEqual(windowsSourcePaths(env, owner), {
    controller: env.GITHUB_WORKSPACE,
    candidate: owner.candidate,
    previous: owner.previous,
  });
  assert.throws(() => windowsSourcePaths(env));
  for (const [key, value] of Object.entries({
    schema: 2,
    ready: false,
    sourceSha: env.GITHUB_SHA,
    runId: "124",
    attempt: "1",
    architecture: "x64",
    controller: "C:\\other",
    vhdPath: "C:\\other.vhdx",
    diskIdentifier: "unknown",
    volumeRoot: "C:\\",
    candidate: "D:\\foreign",
    previous: "D:\\foreign",
  }))
    assert.throws(() => windowsSourcePaths(env, { ...owner, [key]: value }), key);
  for (const volumeRoot of ["D:\\..\\", "\\\\server\\share\\", "D:relative", "D:\\extra\\"])
    assert.throws(() => windowsSourcePaths(env, { ...owner, volumeRoot }));
});

test("x64 and explicit standalone cache proof retain the existing C layout", () => {
  const expected = {
    controller: env.GITHUB_WORKSPACE,
    candidate: env.GITHUB_WORKSPACE,
    previous: "C:\\runner\\temp\\paseo-windows-products-123-2\\previous-source",
  };
  assert.deepEqual(windowsSourcePaths({ ...env, EXPECTED_ARCHITECTURE: "x64" }), expected);
  assert.deepEqual(windowsSourcePaths(env, undefined, { proof: true }), expected);
  const x64 = {
    ...env,
    EXPECTED_ARCHITECTURE: "x64",
    RUNNER_TEMP: "D:\\a\\temp",
    GITHUB_WORKSPACE: "D:\\a\\source",
  };
  assert.deepEqual(windowsSourcePaths(x64), {
    controller: x64.GITHUB_WORKSPACE,
    candidate: x64.GITHUB_WORKSPACE,
    previous: "D:\\a\\temp\\paseo-windows-products-123-2\\previous-source",
  });
  assert.throws(() => windowsSourcePaths(env, owner, { proof: true }));
  assert.throws(() => windowsSourcePaths({ ...env, EXPECTED_ARCHITECTURE: "x86" }));
});
