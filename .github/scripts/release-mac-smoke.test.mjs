import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDeltaPlan, localReleaseFetch, wrapperZstdDir } from "./release-mac-smoke.mjs";

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

test("smoke requires the desktop delta on a dry run, only warns on publish, and allows dependency ranges", () => {
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
      basePath,
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
  assert.throws(() => check({ basePath: null }), /no delta/);
  const published = check({ index: { deltas: [] }, publish: true });
  assert.deepEqual([published.result, published.warnings.length], [false, 1]);
  assert.throws(() => check({ plan: [rangeStep(outputPath)] }), /previous release's delta/);
  const otherDelta = { entry: { path: "/nix/store/dep" }, delta: { fromPath: "/nix/store/x", bytes: 1 } };
  assert.throws(() => check({ plan: [deltaStep, otherDelta] }), /tar range/);
  assert.throws(() => check({ desktopFileSize: 2_000_000 }), /desktop delta is/);
  assert.throws(() => check({ served: 230_000_000 }), /served/);
});

test("the updater wrapper's zstd directory is read from its PATH prefix", () => {
  const zstd = `/nix/store/${"z".repeat(32)}-zstd-1.5.7-bin/bin`;
  const wrapper = `#! /nix/store/${"b".repeat(32)}-bash/bin/bash -e
PATH=\${PATH:+':'\$PATH':'}
PATH=\${PATH/':''${zstd}'':'/':'}
PATH='${zstd}'\$PATH
exec "/nix/store/${"n".repeat(32)}-nodejs-26.11.1/bin/node" "$@"
`;
  assert.equal(wrapperZstdDir(wrapper), zstd);
  assert.throws(() => wrapperZstdDir("exec node"), /no zstd/);
});
