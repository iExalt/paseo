import assert from "node:assert/strict";
import test from "node:test";
import { closureEntries } from "./candidate-nix-export.mjs";

test("closure identity includes its exact root and valid NAR identities", () => {
  const root = `/nix/store/${"0".repeat(32)}-paseo`;
  const dependency = `/nix/store/${"1".repeat(32)}-node`;
  const nar = { narHash: "sha256-" + "a".repeat(43) + "=", narSize: 4096 };
  const info = { [dependency]: nar, [root]: nar };
  assert.deepEqual(
    closureEntries(info, root).map(({ path }) => path),
    [root, dependency],
  );
  assert.throws(() => closureEntries({ [dependency]: nar }, root));
  assert.throws(() => closureEntries({ [root]: { ...nar, narSize: -1 } }, root));
  assert.throws(() => closureEntries({ [root]: { ...nar, narHash: "untrusted" } }, root));
  assert.throws(() => closureEntries({ [root]: nar, "/tmp/foreign": nar }, root));
});
