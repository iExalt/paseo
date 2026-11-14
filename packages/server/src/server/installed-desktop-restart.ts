import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import type { DaemonLifecycleIntent } from "./bootstrap.js";

/** The settings action is an explicit restart; ordinary CLI/crash restarts retain their launch. */
export function createInstalledDesktopRestarter(input: {
  desktopManaged: boolean;
  platform: NodeJS.Platform;
  version: string;
  workerPid: number;
  home: string;
  env: NodeJS.ProcessEnv;
  log: (message: string, fields?: Record<string, unknown>) => void;
}) {
  let pending = false;
  return async (intent: DaemonLifecycleIntent): Promise<boolean> => {
    if (
      !input.desktopManaged ||
      input.platform !== "darwin" ||
      intent.type !== "restart" ||
      !intent.reason?.startsWith("settings_daemon_restart_")
    )
      return false;

    // PASEO_CLI belongs to the old worker launch and may be absent or store-pinned.
    const resources = "/Applications/Paseo.app/Contents/Resources";
    const markerPath = path.join(resources, "paseo-nix-managed.json");
    let markerBytes: Buffer;
    try {
      markerBytes = await readFile(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const marker = JSON.parse(markerBytes.toString("utf8"));
    if (
      marker.schemaVersion !== 1 ||
      marker.managedBy !== "nix" ||
      typeof marker.packageVersion !== "string" ||
      typeof marker.outputPath !== "string" ||
      !/^\/nix\/store\/[^/]+$/.test(marker.outputPath)
    )
      throw new Error("Invalid installed Nix desktop marker; refusing restart handoff");
    if (marker.packageVersion === input.version) return false;
    const storeResources = path.join(
      marker.outputPath,
      "Applications/Paseo.app/Contents/Resources",
    );
    if (!(await readFile(path.join(storeResources, "paseo-nix-managed.json"))).equals(markerBytes))
      throw new Error("Installed Nix desktop marker differs from its store output");
    if (pending) return true;
    pending = true;

    // The CLI captures identity, stops the old supervisor and verifies the installed version.
    // Keep its log outside worker pipes so the handoff outlives this worker's graceful stop.
    let logFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      logFile = await open(path.join(input.home, "daemon-restart.log"), "a", 0o600);
      const helper = spawn(
        path.join(storeResources, "bin/paseo"),
        [
          "daemon",
          "restart",
          "--replace-supervisor",
          "--home",
          input.home,
          "--expected-worker-pid",
          String(input.workerPid),
          "--timeout",
          "60",
          "--json",
          ...(!intent.keepTerminals ? ["--kill-terminals"] : []),
        ],
        { env: input.env, detached: true, stdio: ["ignore", logFile.fd, logFile.fd] },
      );
      helper.on("error", (error) => {
        pending = false;
        input.log("Installed desktop restart handoff failed", {
          error: String(error),
        });
      });
      helper.on("exit", (code) => {
        pending = false;
        if (code !== 0) input.log("Installed desktop restart did not complete", { code });
      });
      helper.unref();
      input.log("Restart handed to installed Nix desktop", {
        version: marker.packageVersion,
        helperPid: helper.pid,
        keepTerminals: intent.keepTerminals,
      });
      return true;
    } catch (error) {
      pending = false;
      throw error;
    } finally {
      await logFile?.close();
    }
  };
}
