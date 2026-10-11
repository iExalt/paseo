import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
assert.equal(process.platform, "win32");
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
assert.equal(process.version, "v26.11.0");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const [operation, root, version] = process.argv.slice(2);
const tooling = join(root, "fixture-tools", "package.json");
const require = createRequire(existsSync(tooling) ? tooling : import.meta.url);
const executableName = "Paseo Windows Fixture.exe";
function inventory(directory) {
  const files = [];
  function walk(relative = "") {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const filename = join(relative, name);
      const stat = lstatSync(join(directory, filename));
      assert.equal(stat.isSymbolicLink(), false, "Fixture files must not be links");
      if (stat.isDirectory()) walk(filename);
      else {
        assert.ok(stat.isFile());
        assert.ok(files.length < 2000, "Bound fixture inventory");
        assert.ok(stat.size <= 256 * 1024 * 1024, "Bound fixture file reads");
        const bytes = readFileSync(join(directory, filename));
        const entry = {
          path: filename,
          bytes: stat.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        if (filename === executableName) {
          assert.equal(bytes.toString("ascii", 0, 2), "MZ");
          const pe = bytes.readUInt32LE(0x3c);
          assert.equal(bytes.toString("ascii", pe, pe + 4), "PE\0\0");
          entry.machine = bytes.readUInt16LE(pe + 4);
        }
        files.push(entry);
      }
    }
  }
  walk();
  return files;
}
if (operation === "build") {
  assert.equal(require("electron/package.json").version, "44.6.0");
  assert.equal(require("electron-builder/package.json").version, "26.15.3");
  for (const fixtureVersion of ["0.9.0", "1.0.0"]) {
    const source = join(root, `source-${fixtureVersion}`);
    cpSync(resolve(".github/scripts/windows-nsis-fixture"), source, { recursive: true });
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: "paseo-windows-fixture",
        version: fixtureVersion,
        main: "main.cjs",
        description: "Disposable installer ownership proof",
        author: "Paseo",
      }),
    );
    const config = join(root, `builder-${fixtureVersion}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        appId: "sh.paseo.ci.windowsfixture",
        productName: "Paseo Windows Fixture",
        executableName: "Paseo Windows Fixture",
        electronVersion: "44.6.0",
        electronDist: dirname(require("electron")),
        npmRebuild: false,
        directories: { output: join(root, "packages") },
        win: { target: ["nsis"], artifactName: `fixture-${fixtureVersion}-${process.arch}.exe` },
        nsis: {
          guid: "5c8e074b-0491-4c4b-a01e-806ad86b9b2f",
          oneClick: false,
          perMachine: false,
          allowToChangeInstallationDirectory: true,
        },
      }),
    );
    execFileSync(
      process.execPath,
      [
        require.resolve("electron-builder/cli.js"),
        "--projectDir",
        source,
        "--config",
        config,
        "--win",
        "nsis",
        `--${process.arch}`,
        "--publish",
        "never",
      ],
      {
        stdio: "inherit",
        timeout: 140000,
        // fix: locked Nsis7z cannot decode the automatic ARM64 executable filter.
        // https://github.com/electron-userland/electron-builder/issues/9983
        env: { ...process.env, ELECTRON_BUILDER_7Z_FILTER: "BCJ" },
      },
    );
    const file = join(root, "packages", `fixture-${fixtureVersion}-${process.arch}.exe`);
    writeFileSync(
      join(root, "evidence", `unpacked-${fixtureVersion}.json`),
      JSON.stringify(
        inventory(
          join(root, "packages", process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked"),
        ),
      ),
    );
    const bytes = readFileSync(file);
    writeFileSync(
      join(root, "evidence", `installer-${fixtureVersion}.json`),
      JSON.stringify({
        version: fixtureVersion,
        architecture: process.arch,
        archiveFilter: "BCJ",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  }
} else if (operation === "inspect") {
  assert.ok(["0.9.0", "1.0.0"].includes(version));
  const installed = inventory(join(root, "Installed App With Spaces"));
  writeFileSync(join(root, "evidence", `installed-${version}.json`), JSON.stringify(installed));
  const unpacked = JSON.parse(readFileSync(join(root, "evidence", `unpacked-${version}.json`)));
  for (const entry of unpacked.filter(
    (file) =>
      file.path === executableName ||
      file.path === join("resources", "app.asar") ||
      /^[^\\/]+\.dll$/i.test(file.path),
  )) {
    assert.deepEqual(
      installed.find((file) => file.path === entry.path),
      entry,
      `Installed payload mismatch: ${entry.path}`,
    );
  }
  assert.equal(
    installed.find((file) => file.path === executableName)?.machine,
    process.arch === "arm64" ? 0xaa64 : 0x8664,
  );
} else if (operation === "ui") {
  assert.ok(["0.9.0", "1.0.0"].includes(version));
  const { chromium } = require("playwright");
  assert.equal(require("playwright/package.json").version, "1.63.0");
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  const executable = join(root, "Installed App With Spaces", executableName);
  const profile = join(root, "profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { stdio: "inherit", env: { ...process.env, PASEO_WINDOWS_FIXTURE_PROFILE: profile } },
  );
  let launchError;
  child.once("error", (error) => {
    launchError = error;
  });
  let browser;
  try {
    const deadline = Date.now() + 30000;
    while (!browser && Date.now() < deadline) {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, "Installed Electron must stay alive");
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      } catch {
        await delay(100);
      }
    }
    assert.ok(browser, "Installed renderer connection required");
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 10000 }));
    await page.waitForFunction(() => Boolean(window.fixture), undefined, { timeout: 10000 });
    const identity = await page.evaluate(() => window.fixture.identity());
    assert.equal(identity.version, version);
    assert.equal(identity.architecture, process.arch);
    assert.equal(
      realpathSync(identity.executable).toLowerCase(),
      realpathSync(executable).toLowerCase(),
    );
    await page.screenshot({ path: join(root, "evidence", `renderer-${version}.png`) });
    await page.evaluate(() => window.fixture.close());
    const closeDeadline = Date.now() + 10000;
    while (child.exitCode === null && Date.now() < closeDeadline) await delay(50);
    assert.equal(child.exitCode, 0, "Normal Electron close required");
    assert.equal(child.signalCode, null);
    writeFileSync(
      join(root, "evidence", `renderer-${version}.json`),
      JSON.stringify({ ...identity, normalClose: true }),
    );
  } finally {
    await browser?.close().catch(() => {});
  }
} else throw new Error(`Unknown operation: ${operation}`);
