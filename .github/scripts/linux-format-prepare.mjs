import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const root = resolve(process.env.FORMAT_ROOT);
const source = resolve(process.env.GITHUB_WORKSPACE);
const payload = join(root, "payload");
assert.equal(
  JSON.parse(readFileSync(join(source, "node_modules/electron-builder/package.json"))).version,
  "26.15.3",
);
assert.ok(["x64", "arm64"].includes(process.env.EXPECTED_ARCHITECTURE));
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
const require = createRequire(import.meta.url);
const { generateAppRunScript } = require("app-builder-lib/out/targets/appimage/appImageUtil.js");
const expectedAppRun = generateAppRunScript({
  DesktopFileName: "PaseoFormatFixture.desktop",
  ExecutableName: "PaseoFormatFixture",
  ProductName: "PaseoFormatFixture",
  ProductFilename: "PaseoFormatFixture",
  ResourceName: "appimagekit-PaseoFormatFixture",
});
writeFileSync(
  join(root, "payload/resources/app-run.sha256"),
  createHash("sha256").update(expectedAppRun).digest("hex"),
);
renameSync(join(payload, "electron"), join(payload, "PaseoFormatFixture.bin"));
copyFileSync(
  join(source, "packages/desktop/scripts/linux-sandbox/launcher.sh"),
  join(payload, "PaseoFormatFixture"),
);
chmodSync(join(payload, "PaseoFormatFixture"), 0o755);
cpSync(join(source, ".github/scripts/linux-format-fixture"), join(payload, "resources/app"), {
  recursive: true,
});
mkdirSync(join(root, "project"));
copyFileSync(
  join(source, ".github/scripts/linux-format-fixture/package.json"),
  join(root, "project/package.json"),
);
writeFileSync(
  join(root, "builder.json"),
  JSON.stringify(
    {
      appId: "sh.paseo.format-fixture",
      productName: "PaseoFormatFixture",
      executableName: "PaseoFormatFixture",
      electronVersion: "44.6.0",
      npmRebuild: false,
      publish: null,
      directories: { output: join(root, "packages") },
      linux: {
        target: ["deb", "rpm", "AppImage"],
        icon: join(source, "packages/desktop/assets/icon.png"),
        category: "Development",
        maintainer: "Paseo <fixture@example.invalid>",
        artifactName: "fixture-" + process.arch + ".${ext}",
      },
      deb: {
        afterInstall: join(source, "packages/desktop/scripts/linux-sandbox/after-install.tpl"),
      },
      rpm: {
        afterInstall: join(source, "packages/desktop/scripts/linux-sandbox/after-install.tpl"),
      },
      appImage: {
        executableArgs: ["--class=PaseoFormatFixture"],
        artifactName: "fixture-" + process.arch + ".AppImage",
      },
    },
    null,
    2,
  ),
);
