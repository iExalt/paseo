import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import afterPack from "./after-pack.js";

test("Darwin packaging makes the retained node-pty helper executable before Nix installation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-after-pack-"));
  try {
    const packageRoot = path.join(
      root,
      "Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty",
    );
    for (const [arch, name] of [
      [1, "x64"],
      [3, "arm64"],
    ]) {
      const helpers = ["build/Release", "build/Debug", `prebuilds/darwin-${name}`].map((dir) =>
        path.join(packageRoot, dir, "spawn-helper"),
      );
      for (const helper of helpers) {
        mkdirSync(path.dirname(helper), { recursive: true });
        writeFileSync(helper, "fixture");
        chmodSync(helper, 0o644);
      }
      await afterPack.default({ appOutDir: root, electronPlatformName: "darwin", arch });
      for (const helper of helpers) assert.equal(statSync(helper).mode & 0o777, 0o755);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
