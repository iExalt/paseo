import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createInstalledDesktopRestarter } from "./installed-desktop-restart.js";

const fixture = vi.hoisted(() => ({
  marker: {
    schemaVersion: 1,
    managedBy: "nix",
    packageVersion: "2.0.0",
    outputPath: "/nix/store/installed-paseo",
  },
  storeMarker: "",
  spawn: vi.fn(),
}));
const cli = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: async (file: string) => (file === cli ? file : fs.realpath(file)),
    readFile: async (file: string) => {
      if (file.endsWith("paseo-nix-managed.json"))
        return Buffer.from(
          file.startsWith("/nix/store/") && fixture.storeMarker
            ? fixture.storeMarker
            : JSON.stringify(fixture.marker),
        );
      return fs.readFile(file);
    },
  };
});

let home: string;
let child: EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "paseo-restart-test-"));
  fixture.marker.packageVersion = "2.0.0";
  fixture.marker.outputPath = "/nix/store/installed-paseo";
  fixture.storeMarker = "";
  child = Object.assign(new EventEmitter(), { pid: 123, unref: vi.fn() });
  fixture.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function restarter(overrides = {}) {
  return createInstalledDesktopRestarter({
    desktopManaged: true,
    platform: "darwin",
    version: "1.0.0",
    workerPid: 456,
    home,
    env: { PASEO_CLI: cli, PRESERVED: "yes" },
    log: vi.fn(),
    ...overrides,
  });
}
const intent = {
  type: "restart" as const,
  reason: "settings_daemon_restart_host",
  keepTerminals: true,
  clientId: "client",
  requestId: "request",
};

test.each([true, false])(
  "settings restart replaces the stale supervisor; keepTerminals=%s",
  async (keepTerminals) => {
    expect(await restarter()({ ...intent, keepTerminals })).toBe(true);
    expect(fixture.spawn).toHaveBeenCalledWith(
      "/nix/store/installed-paseo/Applications/Paseo.app/Contents/Resources/bin/paseo",
      [
        "daemon",
        "restart",
        "--replace-supervisor",
        "--home",
        home,
        "--expected-worker-pid",
        "456",
        "--timeout",
        "60",
        "--json",
        ...(!keepTerminals ? ["--kill-terminals"] : []),
      ],
      expect.objectContaining({
        detached: true,
        env: { PASEO_CLI: cli, PRESERVED: "yes" },
        stdio: ["ignore", expect.any(Number), expect.any(Number)],
      }),
    );
    expect(child.unref).toHaveBeenCalled();
  },
);

test.each([
  { desktopManaged: false },
  { platform: "win32" },
  { platform: "linux" },
  { version: "2.0.0" },
  { env: {} },
])("retains ordinary restart for an ineligible installation: %j", async (overrides) => {
  expect(await restarter(overrides)(intent)).toBe(false);
  expect(fixture.spawn).not.toHaveBeenCalled();
});

test("ordinary CLI restart and shutdown retain their existing lifecycle path", async () => {
  const restart = restarter();
  expect(await restart({ ...intent, reason: "cli_restart" })).toBe(false);
  expect(await restart({ ...intent, type: "shutdown" })).toBe(false);
  expect(fixture.spawn).not.toHaveBeenCalled();
});

test("invalid or mismatched markers cannot launch a replacement", async () => {
  fixture.marker.outputPath = "/untrusted/app";
  await expect(restarter()(intent)).rejects.toThrow("Invalid installed Nix desktop marker");
  fixture.marker.outputPath = "/nix/store/installed-paseo";
  fixture.storeMarker = "different source marker";
  await expect(restarter()(intent)).rejects.toThrow("differs from its store output");
  expect(fixture.spawn).not.toHaveBeenCalled();
});

test("duplicate requests share one handoff; a failed launch permits another explicit request", async () => {
  const restart = restarter();
  expect(await restart(intent)).toBe(true);
  expect(await restart(intent)).toBe(true);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.emit("error", new Error("missing CLI"));
  expect(await restart(intent)).toBe(true);
  expect(fixture.spawn).toHaveBeenCalledTimes(2);
});
