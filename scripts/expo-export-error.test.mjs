import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Expo export preserves the fatal error before exiting with queued logging", () => {
  const source = readFileSync(require.resolve("@expo/cli/build/src/export/exportApp.js"), "utf8");
  const bundleStart = source.indexOf("bundle = await devServer.nativeExportBundleAsync(");
  assert.notEqual(bundleStart, -1);
  const catchStart = source.indexOf("} catch (error) {", bundleStart);
  const catchEnd = source.indexOf(
    "\n                }\n                bundles[platform]",
    catchStart,
  );
  assert.ok(catchStart > bundleStart && catchEnd > catchStart);
  const catchBody = source.slice(catchStart + "} catch (error) {".length, catchEnd);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const error = new Error('paseo-export-regression');
    const queued = () => setTimeout(() => process.stderr.write('queued logger drained'), 1000);
    const _log = { log: queued, error: queued, exception: queued };
    ${catchBody}
  `,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Expo export failed: Error: paseo-export-regression/);
  assert.doesNotMatch(child.stderr, /queued logger drained/);
});
