import { describe, expect, test } from "vitest";
import {
  checkSandboxDaemon,
  checkSandboxStopHome,
  hasSetuidSandbox,
  parseSandboxArgs,
  sandboxElectronEnv,
  sandboxLaunchCommand,
} from "./desktop-sandbox-config.mjs";

describe("desktop sandbox", () => {
  test("Electron gets the sandbox home and loopback-only debugging, and no inherited PASEO_ keys", () => {
    const env = sandboxElectronEnv(
      {
        PATH: "/bin",
        PASEO_HOME: "/real/.paseo",
        PASEO_LISTEN: "127.0.0.1:6767",
        PASEO_ELECTRON_USER_DATA_DIR: "/real/user-data",
        ELECTRON_RUN_AS_NODE: "1",
      },
      { home: "/sandbox", rendererUrl: "http://127.0.0.1:4000/", cdpPort: 9333 },
    );
    expect(env).toEqual({
      PATH: "/bin",
      PASEO_HOME: "/sandbox",
      EXPO_DEV_URL: "http://127.0.0.1:4000/",
      PASEO_ELECTRON_USER_DATA_DIR: "/sandbox/ud",
      PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      PASEO_ELECTRON_FLAGS: "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9333",
    });
  });

  test("runs under Xvfb on Linux and refuses to open a window elsewhere unless asked", () => {
    const base = { electronPath: "/e", appDir: "/app", allowWindow: false };
    expect(sandboxLaunchCommand({ ...base, platform: "linux" })).toEqual({
      command: "xvfb-run",
      args: ["-a", "/e", "/app"],
    });
    expect(sandboxLaunchCommand({ ...base, platform: "linux", setuidSandbox: false }).args).toEqual(
      ["-a", "/e", "--no-sandbox", "/app"],
    );
    expect(hasSetuidSandbox({ uid: 0, mode: 0o104755 })).toBe(true);
    expect(hasSetuidSandbox({ uid: 1000, mode: 0o104755 })).toBe(false);
    expect(hasSetuidSandbox({ uid: 0, mode: 0o100755 })).toBe(false);
    expect(hasSetuidSandbox(null)).toBe(false);
    expect(() => sandboxLaunchCommand({ ...base, platform: "darwin" })).toThrow(/--allow-window/);
    expect(sandboxLaunchCommand({ ...base, platform: "darwin", allowWindow: true })).toEqual({
      command: "/e",
      args: ["/app"],
    });
  });

  test("fails unless the desktop app adopted the sandbox daemon", () => {
    const qa = { home: "/sandbox", serverId: "srv_a" };
    expect(() => checkSandboxDaemon({ home: "/sandbox", serverId: "srv_a" }, qa)).not.toThrow();
    expect(() => checkSandboxDaemon({ home: "/u/.paseo", serverId: "srv_a" }, qa)).toThrow(
      /not the sandbox/,
    );
    expect(() => checkSandboxDaemon({ home: "/sandbox", serverId: "srv_b" }, qa)).toThrow(
      /not the sandbox/,
    );
    expect(() => checkSandboxDaemon(null, qa)).toThrow(/no home/);
  });

  test("only stops homes it started, and parses its options", () => {
    expect(() => checkSandboxStopHome({ home: "/h", hasMarker: false })).toThrow(
      /did not start it/,
    );
    expect(parseSandboxArgs(["--seed", "heavy", "--allow-window"])).toMatchObject({
      mode: "start",
      seed: "heavy",
      allowWindow: true,
    });
    expect(parseSandboxArgs(["--stop", "/h"])).toMatchObject({ mode: "stop", home: "/h" });
    expect(() => parseSandboxArgs(["--metro"])).toThrow(/needs a value/);
    expect(() => parseSandboxArgs(["--bogus"])).toThrow(/Unknown option/);
  });
});
