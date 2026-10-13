const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { extractFile } = require("@electron/asar");

const payloadFiles = [
  "Paseo",
  "Paseo.bin",
  "chrome-sandbox",
  "resources/app.asar",
  "resources/bin/paseo",
];
const digest = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");

function validateManifest(manifest, expectedSha, architecture) {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.architecture, architecture);
  assert.ok(["x64", "arm64"].includes(architecture));
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  assert.equal(manifest.candidate.sourceSha, expectedSha);
  assert.equal(manifest.previous.sourceSha, "b6e0474aec58b2c169f61b81b20de890d4138e30");
  assert.equal(manifest.previous.version, "0.1.0");
  assert.notEqual(manifest.candidate.version, manifest.previous.version);
  for (const item of [manifest.previous, manifest.candidate]) {
    assert.match(item.version, /^\d+\.\d+\.\d+$/);
    assert.match(item.lockHash, /^[a-f0-9]{64}$/);
    assert.equal(item.name, "@getpaseo/desktop");
    assert.equal(item.desktopName, "Paseo.desktop");
    const files = [...payloadFiles, "resources/linux-after-install.sh"];
    assert.deepEqual(Object.keys(item.payload).sort(), [...files].sort());
    for (const hash of Object.values(item.payload)) assert.match(hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(item.artifacts).sort(), ["appimage", "deb", "rpm"]);
    for (const [format, artifact] of Object.entries(item.artifacts)) {
      assert.equal(path.basename(artifact.file), artifact.file);
      assert.match(artifact.file, /^[A-Za-z0-9._-]+$/);
      assert.ok(artifact.file.endsWith(format === "appimage" ? ".AppImage" : `.${format}`));
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      if (format === "appimage") assert.match(artifact.appRunSha256, /^[a-f0-9]{64}$/);
      if (format !== "appimage") {
        assert.match(artifact.packageName, /^(paseo|Paseo)$/);
        assert.equal(artifact.packageName, manifest.previous.artifacts[format].packageName);
      }
    }
  }
}

function verifyPayload(directory, expected, architecture) {
  const metadata = JSON.parse(
    extractFile(path.join(directory, "resources/app.asar"), "package.json").toString(),
  );
  for (const field of ["name", "version", "desktopName"])
    assert.equal(metadata[field], expected[field], field);
  for (const filename of Object.keys(expected.payload))
    assert.equal(digest(path.join(directory, filename)), expected.payload[filename], filename);
  const executable = fs.readFileSync(path.join(directory, "Paseo.bin"));
  assert.equal(executable.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(executable[4], 2, "64-bit ELF required");
  assert.equal(executable[5], 1, "Little-endian ELF required");
  assert.equal(executable.readUInt16LE(18), architecture === "arm64" ? 183 : 62);
  return { directory, metadata, payload: expected.payload };
}

function verifyInstalledPackage(format, expected, architecture) {
  assert.ok(["deb", "rpm"].includes(format));
  const packageName = expected.artifacts[format].packageName;
  const identity =
    format === "deb"
      ? execFileSync(
          "dpkg-query",
          ["-W", "-f=${Package} ${Version} ${Architecture} ${Status}", packageName],
          { encoding: "utf8" },
        )
      : execFileSync("rpm", ["-q", "--queryformat", "%{NAME} %{VERSION} %{ARCH}", packageName], {
          encoding: "utf8",
        });
  const nativeArch = {
    deb: { arm64: "arm64", x64: "amd64" },
    rpm: { arm64: "aarch64", x64: "x86_64" },
  }[format][architecture];
  assert.equal(
    identity,
    `${packageName} ${expected.version} ${nativeArch}${format === "deb" ? " install ok installed" : ""}`,
  );
  assert.equal(fs.realpathSync("/usr/bin/Paseo"), "/opt/Paseo/Paseo");
  const helper = fs.statSync("/opt/Paseo/chrome-sandbox");
  assert.equal(helper.uid, 0);
  assert.equal(helper.mode & 0o7777, 0o4755);
  return { package: identity, ...verifyPayload("/opt/Paseo", expected, architecture) };
}

async function verifyMountedPayload(browser, stableFile, mountsRoot, expected, architecture) {
  const session = await browser.newBrowserCDPSession();
  let browserPid;
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    browserPid = processInfo.find(({ type }) => type === "browser")?.id;
  } finally {
    await session.detach();
  }
  assert.ok(Number.isSafeInteger(browserPid) && browserPid > 0);
  const executable = fs.readlinkSync(`/proc/${browserPid}/exe`);
  const environment = Object.fromEntries(
    fs
      .readFileSync(`/proc/${browserPid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return [item.slice(0, index), item.slice(index + 1)];
      }),
  );
  assert.equal(fs.realpathSync(environment.APPIMAGE), fs.realpathSync(stableFile));
  assert.ok(environment.APPDIR.startsWith(`${mountsRoot}/.mount_`));
  assert.equal(executable, path.join(environment.APPDIR, "Paseo.bin"));
  const mount = JSON.parse(
    execFileSync("findmnt", ["-J", "-T", environment.APPDIR], { encoding: "utf8" }),
  ).filesystems[0];
  assert.match(mount.fstype, /^fuse/);
  assert.equal(mount.target, environment.APPDIR);
  assert.equal(
    digest(path.join(environment.APPDIR, "AppRun")),
    expected.artifacts.appimage.appRunSha256,
  );
  const namespaceProbe = spawnSync("unshare", ["-Ur", "true"], { encoding: "utf8", timeout: 5000 });
  assert.equal(namespaceProbe.error, undefined);
  assert.equal(namespaceProbe.signal, null);
  assert.ok(Number.isInteger(namespaceProbe.status));
  return {
    browserPid,
    executable,
    mount,
    namespaceProbe: { status: namespaceProbe.status, stderr: namespaceProbe.stderr },
    ...verifyPayload(environment.APPDIR, expected, architecture),
  };
}

module.exports = {
  payloadFiles,
  digest,
  validateManifest,
  verifyPayload,
  verifyInstalledPackage,
  verifyMountedPayload,
};
