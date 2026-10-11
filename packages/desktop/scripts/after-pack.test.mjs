import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import afterPack from "./after-pack.js";
import linuxSandbox from "./linux-sandbox/index.js";

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

test("Linux payload retains the shared install policy with validated package names", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-package-hook-"));
  try {
    linuxSandbox.installLinuxPackageHook(root, "PaseoFixture", "PaseoFixture");
    const script = readFileSync(path.join(root, "resources/linux-after-install.sh"), "utf8");
    assert.ok(script.includes("'/opt/PaseoFixture/chrome-sandbox'"));
    assert.ok(script.includes("chmod 4755"));
    assert.ok(script.includes("apparmor_parser --replace"));
    assert.ok(!script.includes("${executable}"));
    assert.ok(!script.includes("${sanitizedProductName}"));
    assert.throws(() => linuxSandbox.installLinuxPackageHook(root, "bad'name", "Paseo"));
    assert.throws(() => linuxSandbox.installLinuxPackageHook(root, "Paseo", "../bad"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "RPM removal preserves integration on upgrade and removes it only on final erase",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-rpm-remove-"));
    try {
      const bin = path.join(root, "bin");
      const profiles = path.join(root, "apparmor");
      mkdirSync(bin);
      mkdirSync(profiles);
      const calls = path.join(root, "calls");
      for (const [name, script] of Object.entries({
        "update-alternatives": '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS"\n',
        apparmor_status: "#!/bin/bash\nexit 1\n",
        rm: '#!/bin/bash\nexec /bin/rm "$@"\n',
      }))
        writeFileSync(path.join(bin, name), script, { mode: 0o755 });
      const script = readFileSync(
        new URL("./linux-sandbox/rpm-after-remove.tpl", import.meta.url),
        "utf8",
      )
        .replaceAll("${executable}", "PaseoFixture")
        .replaceAll("${sanitizedProductName}", "PaseoFixture")
        .replaceAll("/etc/apparmor.d/", profiles + "/");
      const filename = path.join(root, "remove.sh");
      writeFileSync(filename, script);
      const profile = path.join(profiles, "PaseoFixture");
      writeFileSync(profile, "policy");
      const run = (args) =>
        spawnSync("/bin/bash", [filename, ...args], {
          env: { PATH: bin, CALLS: calls },
          encoding: "utf8",
        });
      for (const args of [[], ["garbage"], ["-1"]]) assert.equal(run(args).status, 1);
      assert.equal(run(["1"]).status, 0);
      assert.equal(existsSync(calls), false);
      assert.equal(existsSync(profile), true);
      assert.equal(run(["0"]).status, 0);
      assert.equal(
        readFileSync(calls, "utf8"),
        "--remove PaseoFixture /opt/PaseoFixture/PaseoFixture\n",
      );
      assert.equal(existsSync(profile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
