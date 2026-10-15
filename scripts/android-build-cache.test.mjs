import assert from "node:assert/strict";
import test from "node:test";
import { ccacheVersion } from "../.github/scripts/android-build-cache.mjs";

test("the cache key reads the version banner of the ccache Ubuntu 24.04 ships", () => {
  const banner = "ccache version 4.9.1\nFeatures: file-storage http-storage redis-storage\n";
  assert.equal(ccacheVersion(banner), "4.9.1");
  assert.equal(ccacheVersion("unexpected"), "");
});
