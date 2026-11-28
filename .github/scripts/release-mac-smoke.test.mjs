import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { macDeltaProfile } from "./release-mac-index.mjs";
import {
  checkDeltaPlan,
  localReleaseFetch,
  smokeBaselineTag,
  wrapperZstdDir,
} from "./release-mac-smoke.mjs";

test("the local release shim answers a range with an exact 206 and counts served bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-smoke-shim-"));
  try {
    await writeFile(join(directory, "a.tar"), "0123456789");
    const { fetchImpl, served } = localReleaseFetch(directory);
    const range = await fetchImpl("a.tar", { Range: "bytes=2-4" });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 2-4/10");
    assert.equal(await range.text(), "234");
    const whole = await fetchImpl("a.tar", {});
    assert.deepEqual([whole.status, await whole.text()], [200, "0123456789"]);
    assert.equal(served(), 13);
    await assert.rejects(fetchImpl("a.tar", { Range: "bytes=5-10" }), /Unsatisfiable/);
    await assert.rejects(fetchImpl("../a.tar", {}), /asset name/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the transition smoke seeds 0.38.4 and other releases select the latest stable baseline", async () => {
  assert.equal(
    await smokeBaselineTag("0.39.0", () => assert.fail("listed releases")),
    "paseo-v0.38.4",
  );
  assert.equal(
    await smokeBaselineTag("0.39.1", async () => [
      { tag_name: "paseo-v0.38.4" },
      { tag_name: "paseo-v0.39.0" },
      { tag_name: "paseo-v0.39.1" },
    ]),
    "paseo-v0.39.0",
  );
});

test("smoke checks the prior desktop delta and dependency ranges", () => {
  const outputPath = "/nix/store/new-paseo-desktop";
  const basePath = "/nix/store/old-paseo-desktop";
  const index = { deltas: [{ fromPath: basePath, toPath: outputPath }] };
  const deltaStep = { entry: { path: outputPath }, delta: { fromPath: basePath, bytes: 250_000 } };
  const rangeStep = (path) => ({ entry: { path }, narinfo: { fileSize: 1_000_000 } });
  const check = (overrides) => {
    const warnings = [];
    const result = checkDeltaPlan({
      index,
      plan: [deltaStep],
      outputPath,
      base: { path: basePath, version: "0.38.4" },
      version: "0.39.1",
      desktopFileSize: 150_000_000,
      served: 300_000,
      tarBytes: 230_000_000,
      publish: false,
      warn: (message) => warnings.push(message),
      log: () => {},
      ...overrides,
    });
    return { result, warnings };
  };
  assert.equal(check({}).result, true);
  // A changed dependency arrives as a tar range alongside the desktop delta.
  assert.equal(check({ plan: [deltaStep, rangeStep("/nix/store/dep")] }).result, true);
  assert.throws(() => check({ index: { deltas: [] } }), /no delta/);
  assert.throws(() => check({ base: null }), /no delta/);
  const published = check({ index: { deltas: [] }, publish: true });
  assert.deepEqual([published.result, published.warnings.length], [false, 1]);
  assert.throws(() => check({ plan: [rangeStep(outputPath)] }), /previous release's delta/);
  const otherDelta = {
    entry: { path: "/nix/store/dep" },
    delta: { fromPath: "/nix/store/x", bytes: 1 },
  };
  assert.throws(() => check({ plan: [deltaStep, otherDelta] }), /tar range/);
  assert.throws(() => check({ desktopFileSize: 2_000_000 }), /desktop delta is/);
  assert.throws(() => check({ served: 230_000_000 }), /served/);

  const planWithDelta = (bytes) => [{ ...deltaStep, delta: { ...deltaStep.delta, bytes } }];
  assert.deepEqual(macDeltaProfile("0.38.4", "0.39.0"), { level: "-19", maxBytes: 65_000_000 });
  assert.equal(check({ version: "0.39.0", plan: planWithDelta(65_000_000) }).result, true);
  assert.throws(
    () => check({ version: "0.39.0", plan: planWithDelta(65_000_001) }),
    /limit: 65000000 bytes/,
  );
  assert.throws(
    () => check({ version: "0.39.0", index: { deltas: [] }, publish: true }),
    /no delta/,
  );
  assert.throws(
    () =>
      check({ version: "0.39.0", desktopFileSize: 65_000_000, plan: planWithDelta(65_000_000) }),
    /compressed NAR/,
  );
  assert.throws(() => check({ version: "0.39.0", base: null, publish: true }), /no delta/);
  for (const [from, to] of [
    ["0.38.3", "0.39.0"],
    ["0.38.4", "0.39.1"],
  ]) {
    assert.equal(macDeltaProfile(from, to), undefined);
    const ordinary = { base: { path: basePath, version: from }, version: to };
    assert.equal(check({ ...ordinary, plan: planWithDelta(14_999_999) }).result, true);
    assert.throws(
      () => check({ ...ordinary, plan: planWithDelta(15_000_000) }),
      /limit: below 10%/,
    );
  }
});

test("the updater wrapper's zstd directory is read from its PATH prefix", () => {
  const zstd = `/nix/store/${"z".repeat(32)}-zstd-1.5.7-bin/bin`;
  const wrapper = `#! /nix/store/${"b".repeat(32)}-bash/bin/bash -e
PATH=\${PATH:+':'$PATH':'}
PATH=\${PATH/':''${zstd}'':'/':'}
PATH='${zstd}'$PATH
exec "/nix/store/${"n".repeat(32)}-nodejs-26.11.1/bin/node" "$@"
`;
  assert.equal(wrapperZstdDir(wrapper), zstd);
  assert.throws(() => wrapperZstdDir("exec node"), /no zstd/);
});
