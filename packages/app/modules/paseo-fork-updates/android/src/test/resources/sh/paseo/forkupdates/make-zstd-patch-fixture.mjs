// Regenerates zstd-patch-fixture.zst, the delta ZstdPatchTest applies. The base and target
// bytes come from the same formula as the test, so only the small delta is committed; making
// it with the zstd CLI keeps the test pinned to the format CI produces.
// Usage: node make-zstd-patch-fixture.mjs (needs zstd on PATH)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pattern = (start, length) =>
  Uint8Array.from({ length }, (_, i) => Math.imul(start + i, 0x9e3779b1) >>> 24);
const base = pattern(0, 200_000);
const target = Uint8Array.from([
  ...base.subarray(0, 50_000),
  ...pattern(1_000_000, 1_000),
  ...base.subarray(50_000),
]);
for (let i = 120_000; i < 121_000; i += 1) target[i] ^= 0x5a;

const work = mkdtempSync(join(tmpdir(), "zstd-patch-fixture-"));
try {
  writeFileSync(join(work, "base"), base);
  writeFileSync(join(work, "target"), target);
  const out = join(dirname(fileURLToPath(import.meta.url)), "zstd-patch-fixture.zst");
  execFileSync("zstd", [
    "-q",
    "-f",
    "-19",
    "--long=28",
    `--patch-from=${join(work, "base")}`,
    join(work, "target"),
    "-o",
    out,
  ]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
