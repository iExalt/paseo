import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(import.meta.url);
assert.equal(process.platform, "win32");
assert.equal(process.arch, process.env.EXPECTED_ARCHITECTURE);
assert.equal(process.version, "v26.11.0");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const [operation, root, version] = process.argv.slice(2);
const executableName = "Paseo Windows Fixture.exe";
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
      { stdio: "inherit", timeout: 140000 },
    );
    const file = join(root, "packages", `fixture-${fixtureVersion}-${process.arch}.exe`);
    const bytes = readFileSync(file);
    writeFileSync(
      join(root, "evidence", `installer-${fixtureVersion}.json`),
      JSON.stringify({
        version: fixtureVersion,
        architecture: process.arch,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
  }
} else if (operation === "ui") {
  assert.ok(["0.9.0", "1.0.0"].includes(version));
  const { chromium } = require("playwright");
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
