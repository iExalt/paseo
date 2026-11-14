import { observeServerInfo } from "./status.js";
import { runDiagnosticsCommand } from "./diagnostics.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, test } from "vitest";
import { createStopCommandRunner, type StopCommandDeps } from "./stop.js";

// The daemon the gate is checked against: a connection whose server_info may or may not
// advertise terminalsSurviveRestart, and that records any shutdown it is asked for.
function createFakeDaemon(
  features: { terminalsSurviveRestart?: boolean; shutdownIfIdle?: boolean } = {},
  reply: "shutdown_requested" | "shutdown_declined" = "shutdown_requested",
) {
  const shutdownRequests: Array<{ keepTerminals?: boolean; onlyIfIdle?: boolean }> = [];
  const deps: StopCommandDeps = {
    connectToDaemon: async () => ({
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "fake-daemon",
        version: "0.11.0",
        features,
      }),
      shutdownServer: async (options) => {
        shutdownRequests.push({
          keepTerminals: options?.keepTerminals,
          ...(options?.onlyIfIdle ? { onlyIfIdle: true } : {}),
        });
        return reply === "shutdown_declined"
          ? { status: reply, clientId: "fake-client", requestId: "fake-request", reason: "busy" }
          : { status: reply, clientId: "fake-client", requestId: "fake-request" };
      },
      close: async () => undefined,
    }),
  };
  return { deps, shutdownRequests };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function stop(options: Record<string, unknown>, deps: StopCommandDeps) {
  return createStopCommandRunner(deps)(options as never, new Command("stop"));
}

// A home whose lock names a live stand-in supervisor, so the local stop path runs for real.
function homeWithRunningSupervisor(): { home: string; supervisor: ChildProcess } {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-stop-keep-"));
  const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  writeFileSync(
    path.join(home, "paseo.pid"),
    JSON.stringify({
      pid: supervisor.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:1",
    }),
  );
  cleanups.push(() => {
    supervisor.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  return { home, supervisor };
}

describe("daemon stop --keep-terminals", () => {
  test("refuses an endpoint daemon that does not advertise terminalsSurviveRestart", async () => {
    const daemon = createFakeDaemon();
    await expect(
      stop(
        { daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, keepTerminals: true },
        daemon.deps,
      ),
    ).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
    expect(daemon.shutdownRequests).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "refuses a local daemon without the capability and never signals its supervisor",
    async () => {
      const daemon = createFakeDaemon();
      const { home, supervisor } = homeWithRunningSupervisor();
      await expect(
        stop({ daemonTarget: { kind: "instance", home }, keepTerminals: true }, daemon.deps),
      ).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
      expect(daemon.shutdownRequests).toEqual([]);
      expect(supervisor.exitCode).toBeNull();
      expect(supervisor.signalCode).toBeNull();
    },
  );

  test("asks a capable daemon to keep its terminals", async () => {
    const daemon = createFakeDaemon({ terminalsSurviveRestart: true });
    await stop(
      { daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, keepTerminals: true },
      daemon.deps,
    );
    expect(daemon.shutdownRequests).toEqual([{ keepTerminals: true }]);
  });

  test("rejects --force with --keep-terminals before contacting the daemon", async () => {
    const daemon = createFakeDaemon({ terminalsSurviveRestart: true });
    const { home } = homeWithRunningSupervisor();
    await expect(
      stop(
        { daemonTarget: { kind: "instance", home }, keepTerminals: true, force: true },
        daemon.deps,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(daemon.shutdownRequests).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("daemon stop --if-idle", () => {
  test("refuses a daemon without shutdownIfIdle and never signals its supervisor", async () => {
    const daemon = createFakeDaemon({ terminalsSurviveRestart: true });
    const { home, supervisor } = homeWithRunningSupervisor();
    await expect(
      stop({ daemonTarget: { kind: "instance", home }, ifIdle: true }, daemon.deps),
    ).rejects.toMatchObject({ code: "IDLE_SHUTDOWN_UNSUPPORTED" });
    expect(daemon.shutdownRequests).toEqual([]);
    expect(supervisor.signalCode).toBeNull();
  });

  test("leaves a busy daemon running and reports the decline", async () => {
    const daemon = createFakeDaemon(
      { terminalsSurviveRestart: true, shutdownIfIdle: true },
      "shutdown_declined",
    );
    const { home, supervisor } = homeWithRunningSupervisor();
    const result = await stop(
      { daemonTarget: { kind: "instance", home }, ifIdle: true },
      daemon.deps,
    );
    expect(result.data).toMatchObject({ action: "declined", home });
    expect(daemon.shutdownRequests).toEqual([{ keepTerminals: true, onlyIfIdle: true }]);
    expect(supervisor.exitCode).toBeNull();
    expect(supervisor.signalCode).toBeNull();
  });

  test("rejects --force with --if-idle before contacting the daemon", async () => {
    const daemon = createFakeDaemon({ terminalsSurviveRestart: true, shutdownIfIdle: true });
    const { home } = homeWithRunningSupervisor();
    await expect(
      stop({ daemonTarget: { kind: "instance", home }, ifIdle: true, force: true }, daemon.deps),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(daemon.shutdownRequests).toEqual([]);
  });
});

test("diagnostics refuses unsupported hosts before requesting and always closes", async () => {
  let called = false;
  let closed = false;
  await expect(
    runDiagnosticsCommand(
      { daemonTarget: { kind: "endpoint", host: "localhost:1234" } },
      new Command(),
      async (options) => {
        expect(options.target).toEqual({ kind: "endpoint", host: "localhost:1234" });
        return {
          getLastServerInfoMessage: () => null,
          collectDiagnostics: async () => {
            called = true;
            return { requestId: "x", diagnostic: "unused" };
          },
          close: async () => {
            closed = true;
          },
        };
      },
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
  expect(called).toBe(false);
  expect(closed).toBe(true);
});

test("latency failure preserves live server information", async () => {
  const info = {
    status: "server_info" as const,
    serverId: "host",
    features: { daemonDiagnostics: true },
  };
  const observed = await observeServerInfo(
    {
      getLastServerInfoMessage: () => info,
      measureLatency: async (params) => {
        expect(params).toEqual({ timeoutMs: 1500 });
        throw { code: "TIMEOUT", message: "latency timed out" };
      },
    },
    true,
  );
  expect(observed).toMatchObject({
    serverId: "host",
    features: info.features,
    latencyError: { code: "TIMEOUT" },
  });
  expect(observed).not.toHaveProperty("latencyMs");
});
