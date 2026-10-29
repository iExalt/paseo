import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDeltaPlan, localReleaseFetch } from "./release-mac-smoke.mjs";

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

test("smoke requires the previous release's delta on a dry run and only warns on publish", () => {
  const outputPath = "/nix/store/new-paseo-desktop";
  const basePath = "/nix/store/old-paseo-desktop";
  const index = { deltas: [{ fromPath: basePath, toPath: outputPath }] };
  const deltaStep = { entry: { path: outputPath }, delta: { fromPath: basePath } };
  const check = (overrides) => {
    const warnings = [];
    const result = checkDeltaPlan({
      index,
      plan: [deltaStep],
      outputPath,
      basePath,
      served: 300_000,
      tarBytes: 230_000_000,
      publish: false,
      warn: (message) => warnings.push(message),
      ...overrides,
    });
    return { result, warnings };
  };
  assert.equal(check({}).result, true);
  assert.throws(() => check({ index: { deltas: [] } }), /no delta/);
  assert.throws(() => check({ basePath: null }), /no delta/);
  const published = check({ index: { deltas: [] }, publish: true });
  assert.deepEqual([published.result, published.warnings.length], [false, 1]);
  // A changed dependency or a fallback to the tar range is not the delta-only path.
  assert.throws(() => check({ plan: [deltaStep, { entry: { path: "/nix/store/dep" } }] }), /only the desktop delta/);
  assert.throws(() => check({ plan: [{ entry: { path: outputPath } }] }), /only the desktop delta/);
  assert.throws(() => check({ served: 5_000_000 }), /served/);
});
