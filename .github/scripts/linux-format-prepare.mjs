import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
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
const ts = require("typescript");
const asar = require("@electron/asar");
const { installLinuxPackageHook } = require("../../packages/desktop/scripts/linux-sandbox");
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
installLinuxPackageHook(payload, "PaseoFormatFixture", "PaseoFormatFixture");
const posttrans = join(root, "rpm-posttrans.sh");
writeFileSync(
  posttrans,
  readFileSync(
    join(source, "packages/desktop/scripts/linux-sandbox/rpm-posttrans.sh"),
    "utf8",
  ).replaceAll("/opt/Paseo/", "/opt/PaseoFormatFixture/"),
);
// Exercise the real bundled shim and launcher with a tiny Node entrypoint.
symlinkSync("PaseoFormatFixture.bin", join(payload, "Paseo.bin"));
mkdirSync(join(payload, "resources/bin"), { recursive: true });
copyFileSync(join(source, "packages/desktop/bin/paseo"), join(payload, "resources/bin/paseo"));
chmodSync(join(payload, "resources/bin/paseo"), 0o755);
mkdirSync(join(payload, "resources/app.asar.unpacked/dist/daemon"), { recursive: true });
function compile(relative, output) {
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(
    output,
    ts.transpileModule(readFileSync(join(source, relative), "utf8"), {
      fileName: "fixture.cts",
      compilerOptions: {
        module: ts.ModuleKind.Node16,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
  );
}
compile(
  "packages/desktop/src/daemon/node-entrypoint-runner.ts",
  join(payload, "resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js"),
);
writeFileSync(join(payload, "resources/worker-input.txt"), "mounted worker input\n");
const app = join(root, "app-source");
cpSync(join(source, ".github/scripts/linux-format-fixture"), app, {
  recursive: true,
});
const cli = join(app, "node_modules/@getpaseo/cli/dist");
const supervisor = join(app, "node_modules/@getpaseo/server/dist/scripts");
mkdirSync(cli, { recursive: true });
mkdirSync(supervisor, { recursive: true });
copyFileSync(join(app, "cli-runner.cjs"), join(cli, "index.js"));
copyFileSync(join(app, "supervisor.cjs"), join(supervisor, "supervisor-entrypoint.js"));
compile(
  "packages/cli/src/commands/daemon/appimage-supervisor.ts",
  join(cli, "appimage-supervisor.js"),
);
await asar.createPackage(app, join(payload, "resources/app.asar"));
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
        compression: "gz",
        afterInstall: join(source, "packages/desktop/scripts/linux-sandbox/after-install.tpl"),
      },
      rpm: {
        compression: "gzip",
        afterInstall: join(source, "packages/desktop/scripts/linux-sandbox/after-install.tpl"),
        afterRemove: join(source, "packages/desktop/scripts/linux-sandbox/rpm-after-remove.tpl"),
        fpm: ["--rpm-posttrans", posttrans, "--directories", "/opt/PaseoFormatFixture"],
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
const legacy = JSON.parse(readFileSync(join(root, "builder.json")));
legacy.linux.artifactName = "legacy-" + process.arch + ".${ext}";
legacy.extraMetadata = { version: "0.9.0" };
delete legacy.rpm.afterRemove;
delete legacy.rpm.fpm;
writeFileSync(join(root, "legacy-builder.json"), JSON.stringify(legacy));
