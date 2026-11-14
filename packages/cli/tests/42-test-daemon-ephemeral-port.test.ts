#!/usr/bin/env npx tsx

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTestDaemon, runPaseoCli } from "./helpers/test-daemon.ts";

// Port zero leaves allocation to the listening daemon, with no reserve/release gap.
const daemon = await startTestDaemon({ port: 0 });
try {
  assert(daemon.port > 0, "the helper returns the port the daemon actually bound");
  assert.equal(daemon.wsUrl, `ws://127.0.0.1:${daemon.port}`);
  const result = await runPaseoCli(daemon, ["agent", "ls", "--host", daemon.wsUrl, "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  const file = async (...args: string[]) => {
    const output = await runPaseoCli(daemon, [
      "file",
      ...args,
      "--cwd",
      daemon.workDir,
      "--host",
      daemon.wsUrl,
      "--json",
    ]);
    assert.equal(output.exitCode, 0, output.stderr);
    return JSON.parse(output.stdout);
  };
  await file("create", "data.bin");
  for (const bytes of [Buffer.from([0, 255, 128, 10]), Buffer.alloc(0)]) {
    const input = join(daemon.workDir, "local-input");
    await writeFile(input, bytes);
    const written = await file("write", "data.bin", "--input", input);
    assert.equal(written.status, "written");
    assert.equal((await file("cat", "data.bin")).content, bytes.toString("base64"));
  }
  await file("rename", "data.bin", "renamed.bin");
  const copy = await file("duplicate", "renamed.bin");
  assert(copy.duplicatedPath);
  const output = join(daemon.workDir, "downloaded");
  await file("download", "renamed.bin", output);
  assert.equal((await readFile(output)).length, 0);
  const uploaded = await file("upload", output);
  assert(uploaded);
  await file("create", "folder", "--kind", "directory");
  await file("ls");
  await file("suggest", "renamed");
  await file("rm", copy.duplicatedPath);
  await file("rm", "renamed.bin");
  await file("rm", "folder");
} finally {
  await daemon.stop();
}
