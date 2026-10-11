import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  payloadFiles,
  digest,
  verifyPayload,
} from "../../packages/desktop/e2e/linux-installed-layout.cjs";

const [sourceArg, stage, rootArg] = process.argv.slice(2);
assert.ok(["previous", "candidate"].includes(stage));
const source = resolve(sourceArg);
const root = resolve(rootArg);
const architecture = process.arch;
assert.equal(architecture, process.env.EXPECTED_ARCHITECTURE);
const require = createRequire(join(source, "package.json"));
const yaml = require("js-yaml");
const config = yaml.load(
  readFileSync(join(source, "packages/desktop/electron-builder.yml"), "utf8"),
);
const metadata = JSON.parse(readFileSync(join(source, "packages/desktop/package.json")));
assert.equal(require("electron-builder/package.json").version, "26.15.3");
const payload = join(
  source,
  "packages/desktop/release",
  architecture === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
);
const output = join(root, "packages");
mkdirSync(output, { recursive: true });
const basename = `${stage}-${architecture}`;
config.directories.output = output;
config.linux.target = ["deb", "rpm", "AppImage"];
config.linux.artifactName = `${basename}.\${ext}`;
config.appImage.artifactName = `${basename}.AppImage`;
if (stage === "candidate") {
  assert.equal(config.deb.compression, "gz");
  assert.equal(config.rpm.compression, "gzip");
}
// Rebuild the fixed predecessor with the same archive policy, leaving its payload unchanged.
config.deb.compression = "gz";
config.rpm.compression = "gzip";
const configFile = join(root, `${stage}-builder.json`);
writeFileSync(configFile, JSON.stringify(config));
const identity = {
  name: metadata.name,
  version: metadata.version,
  desktopName: metadata.desktopName,
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
  lockHash: digest(join(source, "package-lock.json")),
  payload: Object.fromEntries(payloadFiles.map((file) => [file, digest(join(payload, file))])),
  artifacts: {},
};
verifyPayload(payload, identity, architecture);
const started = Date.now();
execFileSync(
  process.execPath,
  [
    join(source, "node_modules/electron-builder/cli.js"),
    "--projectDir",
    join(source, "packages/desktop"),
    "--config",
    configFile,
    "--prepackaged",
    payload,
    "--linux",
    "deb",
    "rpm",
    "AppImage",
    `--${architecture}`,
    "--publish",
    "never",
  ],
  { cwd: join(source, "packages/desktop"), stdio: "inherit", timeout: 600000 },
);
for (const format of ["deb", "rpm", "appimage"]) {
  const file = `${basename}.${format === "appimage" ? "AppImage" : format}`;
  const artifact = join(output, file);
  const record = { file, sha256: digest(artifact), bytes: statSync(artifact).size };
  if (format === "deb")
    record.packageName = execFileSync("dpkg-deb", ["-f", artifact, "Package"], {
      encoding: "utf8",
    }).trim();
  if (format === "rpm")
    record.packageName = execFileSync("rpm", ["-qp", "--queryformat", "%{NAME}", artifact], {
      encoding: "utf8",
    }).trim();
  if (format === "appimage") {
    const {
      generateAppRunScript,
    } = require("app-builder-lib/out/targets/appimage/appImageUtil.js");
    record.appRunSha256 = createHash("sha256")
      .update(
        generateAppRunScript({
          DesktopFileName: "Paseo.desktop",
          ExecutableName: "Paseo",
          ProductName: "Paseo",
          ProductFilename: "Paseo",
          ResourceName: "appimagekit-Paseo",
        }),
      )
      .digest("hex");
  }
  identity.artifacts[format] = record;
}
writeFileSync(join(root, `${stage}.json`), JSON.stringify(identity, null, 2));
writeFileSync(
  join(root, "evidence", `${stage}-packaging.json`),
  JSON.stringify(
    {
      sourceSha: identity.sourceSha,
      lockHash: identity.lockHash,
      elapsedMs: Date.now() - started,
      outputOverrides: {
        linux: config.linux.artifactName,
        appImage: config.appImage.artifactName,
        targets: config.linux.target,
        debCompression: config.deb.compression,
        rpmCompression: config.rpm.compression,
      },
    },
    null,
    2,
  ),
);
