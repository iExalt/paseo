import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = new URL("../../packages/desktop/e2e/packaged-app-smoke.js", import.meta.url);
const source = readFileSync(file, "utf8");
const candidate = "b".repeat(40),
  controller = "a".repeat(40);
const sentinel = new Error("Reached packaged application launch");
const root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-stage-source-")));
const windowsIdentity =
  await import('data:text/javascript,export const verifyWindowsJob=()=>({stage:"runtime-candidate"})');
try {
  for (const platform of ["linux", "win32"]) {
    const module = { exports: {} };
    const context = {
      require: createRequire(file),
      module,
      launchSentinel: sentinel,
      process: {
        ...process,
        platform,
        arch: "x64",
        getuid: () => statSync(root).uid,
        env: { ...process.env, GITHUB_SHA: controller },
      },
      console,
      Buffer,
      setTimeout,
      clearTimeout,
    };
    new Script(
      source +
        "\nsmokePackagedDesktopApp = async () => { if (launchSentinel) throw launchSentinel; };",
      {
        filename: file.pathname,
        importModuleDynamically: (specifier) => {
          assert.equal(specifier, "../../../.github/scripts/windows-job-identity.mjs");
          return windowsIdentity;
        },
      },
    ).runInNewContext(context);
    const stageRoot = join(root, platform);
    mkdirSync(stageRoot);
    if (platform === "linux") {
      const payload = Object.fromEntries(
        [
          "Paseo",
          "Paseo.bin",
          "chrome-sandbox",
          "resources/app.asar",
          "resources/bin/paseo",
          "resources/linux-after-install.sh",
        ].map((p) => [p, "c".repeat(64)]),
      );
      const item = {
        sourceSha: candidate,
        version: "0.1.1",
        lockHash: "d".repeat(64),
        name: "@getpaseo/desktop",
        desktopName: "Paseo.desktop",
        payload,
        artifacts: {
          deb: {
            file: "candidate.deb",
            sha256: "e".repeat(64),
            packageName: "paseo",
          },
          rpm: {
            file: "candidate.rpm",
            sha256: "e".repeat(64),
            packageName: "paseo",
          },
          appimage: {
            file: "candidate.AppImage",
            sha256: "e".repeat(64),
            appRunSha256: "f".repeat(64),
          },
        },
      };
      const manifest = {
        schema: 1,
        architecture: "x64",
        previous: {
          ...item,
          version: "0.1.0",
          sourceSha: "b6e0474aec58b2c169f61b81b20de890d4138e30",
        },
        candidate: {
          ...item,
          payload: {
            ...payload,
            "resources/linux-after-install.sh": "f".repeat(64),
          },
        },
      };
      const args = {
        manifest,
        expectedSourceSha: candidate,
        manifestSha256: "1".repeat(64),
        format: "deb",
        stage: "previous",
        root: stageRoot,
        artifactDir: join(stageRoot, "evidence"),
      };
      await assert.rejects(
        module.exports.smokeInstalledLinuxStage({
          ...args,
          expectedSourceSha: controller,
        }),
        { code: "ERR_ASSERTION" },
      );
      await assert.rejects(
        module.exports.smokeInstalledLinuxStage(args),
        (error) => error === sentinel,
      );
    } else {
      const state = join(stageRoot, "state"),
        home = join(state, "daemon"),
        appPath = join(stageRoot, "app");
      mkdirSync(join(home, ".local/bin"), { recursive: true });
      const cli = join(home, ".local/bin/paseo.cmd"),
        contents = `set "BUNDLED_CLI=${join(appPath, "resources/bin/paseo.cmd")}"`;
      writeFileSync(cli, contents);
      const info = statSync(cli);
      const previous = {
        completed: true,
        sourceSha: candidate,
        architecture: "x64",
        ownedSession: {
          userData: join(state, "profile"),
          daemonHome: home,
          port: 12345,
        },
        workspaceId: "wks_fixture",
        cli: { contents, modified: info.mtimeMs, bytes: info.size },
      };
      const previousFile = join(state, "previous.json");
      writeFileSync(previousFile, JSON.stringify(previous));
      const args = {
        expectedSourceSha: candidate,
        stage: "candidate",
        root: stageRoot,
        appPath,
        artifactDir: join(stageRoot, "evidence"),
      };
      await assert.rejects(
        module.exports.smokeInstalledWindowsStage({
          ...args,
          expectedSourceSha: controller,
        }),
        { code: "ERR_ASSERTION" },
      );
      await assert.rejects(
        module.exports.smokeInstalledWindowsStage(args),
        (error) => error === sentinel,
      );
      context.launchSentinel = null;
      await module.exports.smokeInstalledWindowsStage(args);
      assert.equal(JSON.parse(readFileSync(join(state, "candidate.json"))).sourceSha, candidate);
    }
  }
  for (const name of ["linux-product-stage.mjs", "windows-product-runtime.mjs"]) {
    const caller = readFileSync(new URL(`../../.github/scripts/${name}`, import.meta.url), "utf8");
    assert.match(
      caller,
      /await smokeInstalled(?:Linux|Windows)Stage\(\{\s*expectedSourceSha: process\.env\.PASEO_CANDIDATE_SHA \|\| process\.env\.GITHUB_SHA,/,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
