import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DesktopInstallation } from "./nix-managed-install.js";
import {
  createNixUpdaterCommandRunner,
  restartIntoActiveNixRelease,
} from "./nix-managed-updater.js";

const outputPath = "/nix/store/12345678901234567890123456789012-paseo-desktop-0.11.0";
const installation: DesktopInstallation = {
  mode: "nix",
  outputPath,
  cliPath: `${outputPath}/bin/paseo-nix-update`,
  marker: {
    schemaVersion: 1,
    managedBy: "nix",
    packageVersion: "0.11.0",
    buildVersion: "1",
  },
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("Nix updater command bridge", () => {
  it("runs only the fixed CLI command with JSON output and adds running identity", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const run = createNixUpdaterCommandRunner({
      installation,
      runningVersion: "0.10.0",
      spawnProcess: spawnProcess as never,
    });

    const resultPromise = run("status");
    child.stdout.end(
      JSON.stringify({
        ok: true,
        action: "status",
        active: null,
        highWaterVersion: null,
        message: `Unrecognized profile /nix/store/${"a".repeat(32)}-paseo-desktop-0.11.0`,
      }),
    );
    child.stderr.end();
    child.emit("close", 0);

    await expect(resultPromise).resolves.toMatchObject({
      action: "status",
      active: null,
      running: { version: "0.10.0", outputPath },
      message: "Unrecognized profile Nix store output",
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      installation.cliPath,
      ["status", "--json"],
      expect.objectContaining({ shell: false, cwd: outputPath }),
    );
  });

  it("accepts fork release tags and keeps local facts when the release lookup fails", async () => {
    const child = fakeChild();
    const run = createNixUpdaterCommandRunner({
      installation,
      runningVersion: "0.1.1",
      spawnProcess: vi.fn(() => child) as never,
    });
    const active = {
      releaseTag: "paseo-v0.1.1",
      version: "0.1.1",
      outputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-0.1.1`,
    };

    const resultPromise = run("check");
    child.stdout.end(
      JSON.stringify({
        ok: true,
        action: "check",
        active,
        staged: null,
        highWaterVersion: "0.1.1",
        canStage: false,
        latestError: "GitHub rate limit reached while fetching the latest release. Retry later.",
      }),
    );
    child.stderr.end();
    child.emit("close", 0);

    await expect(resultPromise).resolves.toMatchObject({
      active,
      latestError: "GitHub rate limit reached while fetching the latest release. Retry later.",
    });
  });

  it("rejects an unexpected command result instead of exposing it to the renderer", async () => {
    const child = fakeChild();
    const run = createNixUpdaterCommandRunner({
      installation,
      runningVersion: "0.11.0",
      spawnProcess: vi.fn(() => child) as never,
    });

    const resultPromise = run("check");
    child.stdout.end(
      JSON.stringify({ ok: true, action: "stage", active: null, highWaterVersion: null }),
    );
    child.stderr.end();
    child.emit("close", 0);

    await expect(resultPromise).rejects.toThrow("unexpected result");
  });

  it("preserves bounded CLI errors for actionable update failures", async () => {
    const child = fakeChild();
    const run = createNixUpdaterCommandRunner({
      installation,
      runningVersion: "0.11.0",
      spawnProcess: vi.fn(() => child) as never,
    });

    const resultPromise = run("stage");
    child.stdout.end(JSON.stringify({ ok: false, error: "No update is available." }));
    child.stderr.end();
    child.emit("close", 1);

    await expect(resultPromise).rejects.toThrow("No update is available.");
  });

  it("rejects legacy sequence results and malformed semver before exposing updater state", async () => {
    for (const payload of [
      { highWaterSequence: 200008 },
      { highWaterVersion: "0.1.0-beta.1" },
      { highWaterVersion: "0.1.0", active: { version: "0.1.0", releaseTag: "v0.1.1", outputPath } },
    ]) {
      const child = fakeChild();
      const run = createNixUpdaterCommandRunner({
        installation,
        runningVersion: "0.1.0",
        spawnProcess: vi.fn(() => child) as never,
      });
      const result = run("status");
      child.stdout.end(JSON.stringify({ ok: true, action: "status", active: null, ...payload }));
      child.stderr.end();
      child.emit("close", 0);
      await expect(result).rejects.toThrow(/invalid/);
    }
  });
});

describe("Nix restart into the active release", () => {
  const active = {
    releaseTag: "paseo-v0.2.3",
    version: "0.2.3",
    outputPath: "/nix/store/23456789012345678901234567890123-paseo-desktop-0.2.3",
  };
  const status = {
    ok: true as const,
    action: "status" as const,
    active,
    highWaterVersion: "0.2.3",
    running: { version: "0.2.2", outputPath },
  };

  it("stops only the confirmed daemon, then relaunches the active app bundle", async () => {
    const calls: string[] = [];
    await restartIntoActiveNixRelease({
      runNixUpdate: async () => status,
      confirmedDaemon: { pid: 42, startedAt: "2026-10-15T00:00:00.000Z" },
      stopDaemon: async (confirmed) => calls.push(`stop ${confirmed.pid}`),
      relaunch: (execPath) => calls.push(`relaunch ${execPath}`),
      platform: "darwin",
    });
    expect(calls).toEqual([
      "stop 42",
      `relaunch ${active.outputPath}/Applications/Paseo.app/Contents/MacOS/Paseo`,
    ]);
  });

  it("refuses to restart when no release is active", async () => {
    const relaunch = vi.fn();
    await expect(
      restartIntoActiveNixRelease({
        runNixUpdate: async () => ({ ...status, active: null }),
        confirmedDaemon: null,
        stopDaemon: vi.fn(),
        relaunch,
        platform: "darwin",
      }),
    ).rejects.toThrow("no active Nix release");
    expect(relaunch).not.toHaveBeenCalled();
  });
});
