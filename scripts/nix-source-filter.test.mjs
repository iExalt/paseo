import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "paseo-nix-filter-"));
const put = (name, text) => {
  mkdirSync(dirname(join(fixture, name)), { recursive: true });
  writeFileSync(join(fixture, name), text);
};
// Capture each real package filter without realizing a derivation. Rebase only
// its input paths so all existing directory rules also apply to this tiny tree.
const expression = `let
  repo = ${JSON.stringify(repo)};
  fixture = ${JSON.stringify(fixture)};
  lib = import ((builtins.getFlake ("path:" + repo)).inputs.nixpkgs.outPath + "/lib");
  filtered = file: let
    factory = import (repo + "/nix/" + file);
    args = builtins.mapAttrs (_: _: null) (builtins.functionArgs factory);
    package = factory (args // {
      lib = lib // { cleanSourceWith = args: args; };
      buildNpmPackage = args: args;
    });
  in toString (builtins.path {
    path = builtins.toPath fixture;
    name = "paseo-filter-fixture";
    filter = path: type: package.src.filter (repo + lib.removePrefix fixture path) type;
  });
in map filtered [ "package.nix" "desktop-package.nix" ]`;
const identity = () =>
  JSON.parse(
    execFileSync("nix", ["eval", "--offline", "--impure", "--json", "--expr", expression], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );

try {
  const tests = ["test", "spec"].flatMap((kind) =>
    ["js", "jsx", "ts", "tsx", "mjs", "mjsx", "mts", "mtsx", "cjs", "cjsx", "cts", "ctsx"].map(
      (extension) => `packages/app/src/fixture.${kind}.${extension}`,
    ),
  );
  for (const file of tests) put(file, "first test contents");
  const helper = "packages/desktop/e2e/packaged-app-smoke.js";
  const asset = "packages/server/src/server/speech/providers/local/sherpa/assets/silero_vad.onnx";
  put(helper, "runtime helper");
  put(asset, "nested runtime asset");
  const baseline = identity();
  for (const file of tests) put(file, "changed test contents");
  assert.deepEqual(identity(), baseline, "Test-only edits must not invalidate either source");
  put(helper, "changed runtime helper");
  identity().forEach((value, index) =>
    assert.notEqual(value, baseline[index], "Runtime helper must remain included"),
  );
  put(helper, "runtime helper");
  put(asset, "changed nested runtime asset");
  identity().forEach((value, index) =>
    assert.notEqual(value, baseline[index], "Nested runtime asset must remain included"),
  );
  console.log("Both actual Nix filters ignore test edits and retain runtime helpers/assets.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
