import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenCodePatchTarget } from "./postinstall-patches-target.mjs";

test("prefers the server-local OpenCode SDK when both installs exist", () => {
  const target = resolveOpenCodePatchTarget(() => true);

  assert.deepEqual(target, {
    nodeModulesPath: "packages/server/node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: "packages/server",
  });
});

test("uses the hoisted OpenCode SDK when the server-local install is absent", () => {
  const target = resolveOpenCodePatchTarget(
    (candidate) => candidate === "node_modules/@opencode-ai/sdk",
  );

  assert.deepEqual(target, {
    nodeModulesPath: "node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: ".",
  });
});

test("skips the OpenCode patch when the SDK is not installed", () => {
  assert.equal(
    resolveOpenCodePatchTarget(() => false),
    null,
  );
});
