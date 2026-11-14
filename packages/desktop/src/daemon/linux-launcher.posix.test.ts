import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// The launcher reads Linux /proc state as well as POSIX command interfaces.
const it = test.runIf(process.platform === "linux");

const require = createRequire(import.meta.url);
const afterPack = require("../../scripts/after-pack.js").default;

async function launch(
  options: {
    namespaces?: boolean;
    helper?: string;
    mount?: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
    symlink?: boolean;
    rerun?: boolean;
    appImageCli?: boolean;
    expectedStatus?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paseo-launcher-"));
  try {
    const app = join(root, "app with spaces");
    const commands = join(root, "commands");
    mkdirSync(app);
    mkdirSync(commands);
    writeFileSync(
      join(app, "Paseo"),
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(join(app, "Paseo"), 0o755);
    // The command interface represents the host's userns policy, independent of CI's host.
    writeFileSync(join(commands, "unshare"), `#!/bin/sh\nexit ${options.namespaces ? 0 : 1}\n`);
    chmodSync(join(commands, "unshare"), 0o755);
    for (const [name, output] of Object.entries({
      stat: options.helper ?? "1000:755",
      findmnt: options.mount ?? "rw",
    })) {
      writeFileSync(join(commands, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
      chmodSync(join(commands, name), 0o755);
    }
    writeFileSync(join(app, "chrome-sandbox"), "helper");
    chmodSync(join(app, "chrome-sandbox"), 0o755);
    await afterPack({ appOutDir: app, electronPlatformName: "linux", arch: 1 });
    if (options.rerun) await afterPack({ appOutDir: app, electronPlatformName: "linux", arch: 1 });
    if (options.appImageCli) {
      mkdirSync(join(app, "resources/bin"), { recursive: true });
      writeFileSync(
        join(app, "resources/bin/paseo"),
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
      );
      chmodSync(join(app, "resources/bin/paseo"), 0o755);
    }
    const executablePath = options.symlink ? join(root, "paseo") : join(app, "Paseo");
    if (options.symlink) symlinkSync(join(app, "Paseo"), executablePath);
    const args = options.args ?? ["path with spaces", "$(touch never)", "semi;colon", "*.txt"];
    const result = spawnSync(executablePath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        PATH: `${commands}:${process.env.PATH}`,
        APPIMAGE: "/tmp/Paseo.AppImage",
        ...(options.appImageCli
          ? { APPIMAGE: join(app, "Paseo.bin"), APPDIR: app, ARGV0: join(root, "paseo") }
          : {}),
        PASEO_DESKTOP_SMOKE: "0",
        ...options.env,
      },
    });
    expect(result.status, result.stderr).toBe(options.expectedStatus ?? 0);
    return {
      args: result.stdout ? JSON.parse(result.stdout) : [],
      stderr: result.stderr,
      input: args,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.runIf(process.platform !== "win32")(
  "preserves the verified installed CLI link without resolving its final symlink",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-cli-link-")));
    try {
      const app = join(root, "app");
      const bin = join(app, "resources/bin");
      mkdirSync(bin, { recursive: true });
      const shim = join(bin, "paseo");
      copyFileSync(new URL("../../bin/paseo", import.meta.url), shim);
      chmodSync(shim, 0o755);
      const image = join(root, "Paseo.AppImage");
      writeFileSync(image, "fixture");
      chmodSync(image, 0o755);
      const link = join(root, "paseo");
      symlinkSync(image, link);
      writeFileSync(
        join(app, "Paseo.bin"),
        `#!${process.execPath}\nconsole.log(JSON.stringify({cli:process.env.PASEO_CLI,args:process.argv.slice(2)}));\n`,
      );
      chmodSync(join(app, "Paseo.bin"), 0o755);
      const env = {
        ...process.env,
        APPDIR: app,
        APPIMAGE: image,
        OWD: root,
        PATH: `${root}:${process.env.PATH}`,
      };
      for (const argv0 of [link, "./paseo", "paseo"]) {
        const result = spawnSync(shim, ["argument with spaces"], {
          cwd: root,
          encoding: "utf8",
          env: { ...env, ARGV0: argv0 },
        });
        expect(result.status, result.stderr).toBe(0);
        const receipt = JSON.parse(result.stdout);
        expect(receipt.cli).toBe(link);
        expect(receipt.args.at(-1)).toBe("argument with spaces");
      }
      const invalid = spawnSync(shim, [], { encoding: "utf8", env: { ...env, ARGV0: shim } });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("AppImage CLI");
      const direct = spawnSync(shim, ["status", "argument with spaces"], {
        encoding: "utf8",
        env: { ...env, ARGV0: image },
      });
      expect(direct.status, direct.stderr).toBe(0);
      expect(JSON.parse(direct.stdout).cli).toBe(shim);
      expect(JSON.parse(direct.stdout).args.slice(-2)).toEqual(["status", "argument with spaces"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform !== "win32")(
  "routes the installed AppImage CLI before Chromium and preserves remaining arguments",
  async () => {
    const args = [
      "path with spaces",
      "$(touch never)",
      "literal'quote",
      "--class=keep",
      "--no-sandbox",
    ];
    const result = await launch({
      appImageCli: true,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      args: ["--no-sandbox", ...args],
    });
    expect(result.args).toEqual(args);
    expect(result.stderr).toBe("");
  },
);

test.runIf(process.platform !== "win32")(
  "selects only its own fixed supervisor entry before Node passthrough",
  async () => {
    const result = await launch({
      appImageCli: true,
      env: { ELECTRON_RUN_AS_NODE: "1", PASEO_APPIMAGE_SUPERVISOR: "1" },
      args: ["--no-sandbox", "argument with spaces"],
    });
    expect(result.args[0]).toBe("--disable-warning=DEP0040");
    expect(result.args[1]).toMatch(
      /\/resources\/app.asar.unpacked\/dist\/daemon\/node-entrypoint-runner.js$/,
    );
    expect(result.args[2]).toBe("node-script");
    expect(result.args[3]).toMatch(
      /\/resources\/app.asar\/node_modules\/@getpaseo\/server\/dist\/scripts\/supervisor-entrypoint.js$/,
    );
    expect(result.args.slice(4)).toEqual(["argument with spaces"]);
    const invalid = await launch({
      appImageCli: true,
      env: { PASEO_APPIMAGE_SUPERVISOR: "1", ELECTRON_RUN_AS_NODE: "1", APPDIR: "/" },
      expectedStatus: 1,
    });
    expect(invalid.stderr).toContain("Invalid AppImage supervisor context");
  },
);

it("launches a portable app with the fallback on argv when user namespaces are denied", async () => {
  const result = await launch();
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
  expect(result.stderr).toContain("[linux-sandbox] disabled");
});

it("keeps sandboxing for AppImage when the real user can create namespaces", async () => {
  const result = await launch({ namespaces: true });
  expect(result.args).toEqual(result.input);
  expect(result.stderr).toContain("[linux-sandbox] enabled: user namespaces available");
});

it("keeps sandboxing via the installed root-owned helper when userns is denied", async () => {
  const result = await launch({ helper: "0:4755", env: { APPIMAGE: "" } });
  expect(result.args).toEqual(result.input);
  expect(result.stderr).toContain("[linux-sandbox] enabled: root-owned SUID helper available");
});

it("does not trust 4755 on a nosuid mount", async () => {
  const result = await launch({ helper: "0:4755", mount: "rw,nosuid,nodev" });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
});

it("preserves sandbox flags and all Node entrypoint arguments without probing", async () => {
  const result = await launch({ env: { ELECTRON_RUN_AS_NODE: "1" }, args: ["--version"] });
  expect(result.args).toEqual(["--version"]);
  expect(result.stderr).toBe("");
});

it("reports an explicit user override without injecting a duplicate", async () => {
  const result = await launch({ namespaces: true, args: ["--no-sandbox", "--version"] });
  expect(result.args).toEqual(result.input);
  expect(result.stderr).toContain("[linux-sandbox] disabled: requested by --no-sandbox");
});

it("resolves symlink launches and keeps the real executable intact on repeated packaging", async () => {
  const result = await launch({ symlink: true, rerun: true });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
});

it("does not depend on APPIMAGE being present for an extracted portable app", async () => {
  const result = await launch({ env: { APPIMAGE: "" } });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
});

it("applies a debugging environment sandbox override before Chromium starts", async () => {
  const result = await launch({
    namespaces: true,
    env: { PASEO_ELECTRON_FLAGS: "--disable-gpu\t--no-sandbox" },
  });
  expect(result.args).toEqual(["--no-sandbox", ...result.input]);
  expect(result.stderr).toContain("requested by PASEO_ELECTRON_FLAGS");
});
