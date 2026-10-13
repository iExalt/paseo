import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildIdentity,
  builderChain,
  parseProcesses,
  sameChain,
  shouldSample,
} from "../.github/scripts/macos-build-observer.mjs";

test("observer selects only the current desktop builder and rejects reused process identities", () => {
  const rows =
    "10 1 Tue Oct 13 10:00:00 2026 /nix/var/nix/profiles/default/bin/nix-daemon\n11 10 Tue Oct 13 10:00:01 2026 /nix/store/bash/bin/bash\n12 11 Tue Oct 13 10:00:02 2026 /nix/store/node/bin/node\n";
  const processes = parseProcesses(rows);
  const root = "/nix/var/nix/builds/nix-10588-2250876892";
  const output = `/nix/store/${"a".repeat(32)}-paseo-desktop-0.2.0`;
  const marker = (value) => `paseo-desktop> PASEO_DESKTOP_BUILD_IDENTITY=${JSON.stringify(value)}`;
  assert.equal(buildIdentity("unrelated log", output, "0.2.0"), null);
  for (const buildRoot of [root, "/private/tmp/nix-build-paseo-desktop-0.2.0.drv-0"]) {
    assert.deepEqual(buildIdentity(marker({ root: buildRoot, output }), output, "0.2.0"), {
      root: buildRoot,
      output,
    });
  }
  for (const invalid of [
    { root, output: `${output}-other` },
    { root: `${root}/../other`, output },
    { root: "/private/tmp/nix-build-paseo-desktop-0.1.0.drv-0", output },
    { root: "/Users/runner/source", output },
    { root, output, extra: true },
  ])
    assert.throws(() => buildIdentity(marker(invalid), output, "0.2.0"));
  assert.throws(() => buildIdentity("PASEO_DESKTOP_BUILD_IDENTITY={", output, "0.2.0"));
  const cwd = `p12\nfcwd\nn${root}/source/packages/app\n`;
  const chain = builderChain(processes, 12, cwd, root);
  assert.deepEqual(
    chain.map((process) => process.pid),
    [12, 11, 10],
  );
  assert.equal(sameChain(chain, processes), true);
  assert.equal(sameChain(chain, parseProcesses(rows.replace("10:00:02", "10:01:02"))), false);
  assert.deepEqual(builderChain(processes, 12, cwd, `${root}1`), []);
  for (const outside of [
    `${root}/source-other`,
    `${root}/source/../other`,
    "/Users/runner/source",
  ]) {
    assert.deepEqual(builderChain(processes, 12, `n${outside}\n`, root), []);
  }
  assert.deepEqual(builderChain(parseProcesses(rows.replace("11 10", "11 12")), 12, cwd, root), []);
});

test("observer sampling is bounded by genuine build silence and round count", () => {
  assert.equal(
    shouldSample({ metroStarted: false, now: 900000, lastProgress: 0, lastSample: 0, rounds: 0 }),
    false,
  );
  assert.equal(
    shouldSample({ metroStarted: true, now: 300000, lastProgress: 0, lastSample: 0, rounds: 0 }),
    true,
  );
  assert.equal(
    shouldSample({ metroStarted: true, now: 300000, lastProgress: 1, lastSample: 0, rounds: 0 }),
    false,
  );
  assert.equal(
    shouldSample({ metroStarted: true, now: 300000, lastProgress: 0, lastSample: 1, rounds: 1 }),
    false,
  );
  assert.equal(
    shouldSample({
      metroStarted: true,
      now: 900000,
      lastProgress: 0,
      lastSample: 300000,
      rounds: 2,
    }),
    false,
  );
});

test(
  "real build wrapper preserves success/failure and cleans up its observer without contaminating the build log",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-observer-test-"));
    try {
      mkdirSync(join(root, ".github/scripts"), { recursive: true });
      writeFileSync(
        join(root, "wrapper.sh"),
        readFileSync(new URL("../.github/scripts/observe-macos-build.sh", import.meta.url)),
      );
      writeFileSync(
        join(root, ".github/scripts/macos-build-observer.mjs"),
        `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { writeFileSync('observer-stopped', 'yes'); process.exit(0); });
console.error('observer-only');
writeFileSync('observer-pid', String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      writeFileSync(
        join(root, ".github/scripts/nix-release-closure.sh"),
        `set -eu
test "$1" = build
for i in {1..100}; do test ! -e observer-pid || break; sleep 0.01; done
test -e observer-pid
echo build-stdout
echo build-stderr >&2
exit "$TEST_BUILD_STATUS"
`,
      );
      for (const status of [0, 17]) {
        const result = spawnSync("bash", ["wrapper.sh"], {
          cwd: root,
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, RUNNER_TEMP: root, TEST_BUILD_STATUS: String(status) },
        });
        assert.equal(result.status, status, result.stderr);
        assert.equal(result.stdout, "build-stdout\n");
        assert.equal(
          readFileSync(join(root, "paseo-macos-build-stderr.log"), "utf8"),
          "build-stderr\n",
        );
        assert.equal(readFileSync(join(root, "observer-stopped"), "utf8"), "yes");
        assert.throws(
          () => process.kill(Number(readFileSync(join(root, "observer-pid"), "utf8")), 0),
          { code: "ESRCH" },
        );
        for (const name of ["observer-pid", "observer-stopped", "paseo-macos-build-stderr.log"])
          rmSync(join(root, name));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
