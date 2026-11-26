import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { isPlatform } from "../src/test-utils/platform.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorPath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopFixtureDescendant(descendantPid: number) {
  if (descendantPid > 0 && isProcessRunning(descendantPid)) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function runSupervisorFixture(options: {
  workerSource: string;
  restartOnCrash?: boolean;
  timeoutMs?: number;
  workerTerminationGraceMs?: number;
  /** POSIX RLIMIT_FSIZE for the supervisor, in 512-byte blocks: writes past it fail like a full disk. */
  fileSizeLimitBlocks?: number;
  /** Occupy the log path with a directory so the supervisor cannot open daemon.log. */
  blockLogPath?: boolean;
  /** Close the reading end of the supervisor's stdout and stderr as soon as it starts. */
  closeOutput?: boolean;
  releaseOnLogFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  log: string;
  descendantAlive: boolean;
  stdout: string;
  stderr: string;
}> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-log-"));
  const logPath = path.join(tempDir, "daemon.log");
  const workerPath = path.join(tempDir, "worker.mjs");
  const runnerPath = path.join(tempDir, "runner.mjs");

  if (options.blockLogPath) {
    await mkdir(logPath);
  }
  await writeFile(
    workerPath,
    `
      import { readFile as readFixtureFile } from "node:fs/promises";
      import { setTimeout as pollDelay } from "node:timers/promises";
      async function waitForFixtureFile(file, text) {
        const signal = AbortSignal.timeout(20_000);
        while (true) {
          const contents = await readFixtureFile(${JSON.stringify(tempDir)} + "/" + file, "utf8")
            .catch(error => {
              if (error.code !== "ENOENT") throw error;
              return "";
            });
          if (contents.includes(text)) return;
          await pollDelay(25, undefined, { signal });
        }
      }
      process.on("disconnect", () => process.exit(1));
      if (!process.connected) process.exit(1);
      process.send?.({ type: "paseo:ready", listen: "fixture", serverId: "srv_fixture" });
      ${options.workerSource}
    `,
  );
  await writeFile(
    runnerPath,
    `
      import { runSupervisor } from ${JSON.stringify(pathToFileURL(supervisorPath).href)};

      runSupervisor({
        name: "TestSupervisor",
        startupMessage: "starting fixture",
        resolveWorkerEntry: () => ${JSON.stringify(workerPath)},
        workerArgs: [],
        workerEnv: process.env,
        workerExecArgv: [],
        restartOnCrash: ${JSON.stringify(options.restartOnCrash ?? false)},
        workerTerminationGraceMs: ${JSON.stringify(options.workerTerminationGraceMs)},
        logFile: {
          path: ${JSON.stringify(logPath)},
          rotate: { maxSize: "1m", maxFiles: 2 },
        },
      });
    `,
  );

  const runnerArgs = [process.execPath, "--import", "tsx", runnerPath];
  const [command, ...args] =
    options.fileSizeLimitBlocks === undefined
      ? runnerArgs
      : [
          "/bin/sh",
          "-c",
          `ulimit -f ${options.fileSizeLimitBlocks} && exec "$@"`,
          "sh",
          ...runnerArgs,
        ];
  const child = spawn(command, args, {
    cwd: repoRoot,
    // A Node color-conflict warning can hit closed stderr before runSupervisor installs
    // its pipe-error handlers. This fixture exercises the supervisor's own output.
    env: { ...process.env, ...options.env, NO_COLOR: undefined, FORCE_COLOR: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (options.closeOutput) {
    child.stdout.destroy();
    child.stderr.destroy();
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  let released = false;
  let releaseError: unknown;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (
      options.releaseOnLogFailure &&
      !released &&
      stderr.includes(`Cannot write ${logPath}, will retry on the next log line`)
    ) {
      released = true;
      try {
        if (options.blockLogPath) rmdirSync(logPath);
        writeFileSync(path.join(tempDir, "log-release"), "continue");
      } catch (error) {
        releaseError = error;
        child.kill("SIGKILL");
      }
    }
  });

  let descendantPid = 0;
  try {
    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      let timedOut = false;
      let spawnError: Error | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 25_000);

      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (exitCode, exitSignal) => {
        clearTimeout(timeout);
        if (spawnError) reject(spawnError);
        else if (timedOut) reject(new Error(`supervisor fixture timed out\n${stderr}`));
        else resolve({ code: exitCode, signal: exitSignal });
      });
    });

    if (releaseError) throw releaseError;
    const log = await readLogIfWritten(logPath);
    descendantPid = Number(await readLogIfWritten(workerPath + ".descendant"));
    const descendantAlive = descendantPid > 0 && isProcessRunning(descendantPid);
    return { code, signal, log, stdout, stderr, descendantAlive };
  } finally {
    descendantPid ||= Number(await readLogIfWritten(workerPath + ".descendant"));
    try {
      stopFixtureDescendant(descendantPid);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function readLogIfWritten(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

describe("supervisor durable logging", { timeout: 30_000 }, () => {
  test("resolves rotation defaults", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(paseoHome, {}, {});

    expect(logFile).toEqual({
      path: path.join(paseoHome, "daemon.log"),
      rotate: { maxSize: "10m", maxFiles: 3 },
    });
  });

  test("lets persisted rotation override env rotation defaults", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(
      paseoHome,
      {
        log: {
          file: {
            path: "logs/daemon.log",
            rotate: { maxSize: "25m", maxFiles: 4 },
          },
        },
      },
      {
        PASEO_LOG_ROTATE_SIZE: "200m",
        PASEO_LOG_ROTATE_COUNT: "12",
      },
    );

    expect(logFile).toEqual({
      path: path.resolve(paseoHome, "logs", "daemon.log"),
      rotate: { maxSize: "25m", maxFiles: 4 },
    });
  });

  test("uses env rotation when persisted rotation is absent", () => {
    const paseoHome = path.join(path.sep, "tmp", "paseo-home");
    const logFile = resolveSupervisorLogFile(
      paseoHome,
      {},
      {
        PASEO_LOG_ROTATE_SIZE: "50m",
        PASEO_LOG_ROTATE_COUNT: "8",
      },
    );

    expect(logFile).toEqual({
      path: path.join(paseoHome, "daemon.log"),
      rotate: { maxSize: "50m", maxFiles: 8 },
    });
  });

  test("writes supervised worker stdout and stderr to daemon.log", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('{"level":30,"msg":"worker-json-stdout"}\\n');
        process.stderr.write('{"level":50,"msg":"worker-json-stderr"}\\n');
        process.exit(0);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"worker-json-stdout"');
    expect(result.log).toContain('"worker-json-stderr"');
    expect(result.stdout).toContain('"worker-json-stdout"');
    expect(result.stderr).toContain('"worker-json-stderr"');
  });

  test.each([
    { colors: "inherited", env: {} },
    { colors: "conflicting", env: { NO_COLOR: "1", FORCE_COLOR: "1" } },
  ])(
    "keeps supervising the worker when nobody reads its stdout or stderr with $colors colors",
    async ({ env }) => {
      const result = await runSupervisorFixture({
        closeOutput: true,
        env,
        workerSource: `
        process.on("message", (message) => {
          if (message?.type === "paseo:graceful-shutdown") process.exit(0);
        });
        process.stdout.write("first stdout line\\n");
        process.stderr.write("first stderr line\\n");
        process.stdout.write("later stdout line\\n");
        await waitForFixtureFile("daemon.log", "later stdout line");
        process.send?.({ type: "paseo:shutdown", reason: "closed_output_probe" });
        setInterval(() => {}, 1000);
      `,
      });

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.log).toContain("first stderr line\n");
      expect(result.log).toContain("later stdout line\n");
      expect(result.log).toContain('"reason":"closed_output_probe"');
    },
  );

  test("preserves raw non-JSON stdout and stderr lines", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.stdout.write('raw stdout line\\n');
        process.stderr.write('raw stderr line\\n');
        process.exit(0);
      `,
    });

    expect(result.log).toContain("raw stdout line\n");
    expect(result.log).toContain("raw stderr line\n");
  });

  test("logs the worker shutdown reason before requesting graceful shutdown", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        process.on("message", (message) => {
          if (message?.type === "paseo:graceful-shutdown") process.exit(0);
        });
        process.send?.({ type: "paseo:shutdown", reason: "client_shutdown_rpc" });
        setInterval(() => {}, 1000);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"msg":"Worker requested shutdown"');
    expect(result.log).toContain('"reason":"client_shutdown_rpc"');
    expect(result.log).toContain('"msg":"Supervisor requesting graceful worker shutdown"');
    expect(result.log).toContain('"workerPid":');
  });

  test("lets the worker clean up its descendant before supervised shutdown", async () => {
    const result = await runSupervisorFixture({
      workerSource: `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";

        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { detached: true, stdio: "ignore" },
        );
        writeFileSync(process.argv[1] + ".descendant", String(descendant.pid));
        descendant.unref();
        process.stdout.write(\`DESCENDANT_PID=\${descendant.pid}\\n\`);

        process.on("message", (message) => {
          if (message?.type !== "paseo:graceful-shutdown") return;
          descendant.once("exit", () => {
            process.stdout.write("GRACEFUL_CLEANUP_RAN\\n");
            process.exit(0);
          });
          descendant.kill("SIGTERM");
        });

        process.send?.({ type: "paseo:shutdown", reason: "descendant_cleanup_probe" });
        setInterval(() => {}, 1000);
      `,
    });

    const descendantPid = Number.parseInt(
      result.stdout.match(/DESCENDANT_PID=(\d+)/)?.[1] ?? "",
      10,
    );
    expect(Number.isInteger(descendantPid)).toBe(true);

    expect.soft(result.stdout).toContain("GRACEFUL_CLEANUP_RAN");
    expect(result.descendantAlive).toBe(false);
  });

  test("forces shutdown when a worker ignores the graceful shutdown request", async () => {
    const result = await runSupervisorFixture({
      timeoutMs: 8_000,
      workerTerminationGraceMs: 500,
      workerSource: `
          process.send?.({ type: "paseo:shutdown", reason: "stalled_worker_shutdown" });
          setInterval(() => {}, 1_000);
        `,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.log).toContain('"reason":"stalled_worker_shutdown"');
    expect(result.log).toContain(
      '"msg":"Worker did not exit after graceful shutdown request; forcing process tree kill"',
    );
  }, 12_000);

  test.skipIf(isPlatform("win32"))(
    "restarts after worker exit while a descendant retains the worker stdio",
    async () => {
      const result = await runSupervisorFixture({
        workerSource: `
          import { spawn } from "node:child_process";
          import { existsSync, readFileSync, writeFileSync } from "node:fs";

          process.on("message", (message) => {
            if (message?.type === "paseo:graceful-shutdown") process.exit(0);
          });
          const marker = process.argv[1] + ".descendant";
          if (!existsSync(marker)) {
            const descendant = spawn(
              process.execPath,
              [
                "-e",
                "const fs = require('node:fs'); process.on('SIGTERM', () => {});" +
                  "process.on('SIGUSR2', () => fs.writeFileSync(process.argv[1], 'alive'));" +
                  "process.send('holding'); setInterval(() => {}, 1000);",
                marker + ".alive",
              ],
              { detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] },
            );
            writeFileSync(marker, String(descendant.pid));
            await new Promise(resolve => descendant.once("message", resolve));
            descendant.disconnect();
            descendant.unref();
            process.send?.({ type: "paseo:restart", reason: "stdio_descendant" });
            setInterval(() => {}, 1000);
          } else {
            process.kill(Number(readFileSync(marker, "utf8")), "SIGUSR2");
            await waitForFixtureFile("worker.mjs.descendant.alive", "alive");
            process.send?.({ type: "paseo:shutdown", reason: "stdio_restart_complete" });
            setInterval(() => {}, 1000);
          }
        `,
      });

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.log).toContain('"reason":"stdio_restart_complete"');
      expect(result.log).toContain('"reason":"stdio_descendant"');
      expect(result.log).toContain("Restarting worker");
    },
    30_000,
  );

  // POSIX-only: Windows reports the worker self-kill as an exit code, not SIGKILL.
  test.skipIf(isPlatform("win32"))(
    "logs worker signal exits even when the worker cannot log",
    async () => {
      const result = await runSupervisorFixture({
        workerSource: `
        process.kill(process.pid, "SIGKILL");
      `,
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.log).toContain('"msg":"Worker exited"');
      expect(result.log).toContain('"signal":"SIGKILL"');
      expect(result.log).toContain("Supervisor exiting");
    },
  );

  // POSIX-only: RLIMIT_FSIZE is how the test makes daemon.log writes fail.
  test.skipIf(isPlatform("win32"))(
    "keeps supervising the worker when daemon.log can no longer be written",
    async () => {
      const result = await runSupervisorFixture({
        fileSizeLimitBlocks: 128,
        releaseOnLogFailure: true,
        workerSource: `
          process.on("message", (message) => {
            if (message?.type === "paseo:graceful-shutdown") process.exit(0);
          });
          const line = '{"level":30,"msg":"' + "x".repeat(1000) + '"}\\n';
          for (let i = 0; i < 200; i += 1) process.stdout.write(line);
          await waitForFixtureFile("log-release", "continue");
          process.send?.({ type: "paseo:shutdown", reason: "log_write_failure_probe" });
          setInterval(() => {}, 1000);
        `,
      });

      expect(result.stderr).not.toContain("Unhandled 'error' event");
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    },
  );

  test("resumes writing daemon.log once the log path is writable again", async () => {
    const result = await runSupervisorFixture({
      blockLogPath: true,
      releaseOnLogFailure: true,
      workerSource: `

        process.on("message", (message) => {
          if (message?.type === "paseo:graceful-shutdown") process.exit(0);
        });
        process.stdout.write("line while daemon.log is blocked\\n");
        await waitForFixtureFile("log-release", "continue");
        process.stdout.write("line after daemon.log is writable\\n");
        await waitForFixtureFile("daemon.log", "line after daemon.log is writable");
        process.send?.({ type: "paseo:shutdown", reason: "log_recovery_probe" });
        setInterval(() => {}, 1000);
      `,
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain("line after daemon.log is writable\n");
    expect(result.log).toContain('"reason":"log_recovery_probe"');
  });
});
