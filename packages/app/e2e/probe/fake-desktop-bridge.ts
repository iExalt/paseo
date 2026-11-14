import type { DesktopHostBridge } from "@/desktop/host";

export type FakeDesktopScenarioName = "local-daemon" | "daemon-starting";

/** Plain data, since Playwright serializes it into the page with the installer. */
export interface FakeDesktopScenario {
  platform: "darwin" | "linux" | "win32";
  serverId: string;
  listen: string | null;
  daemon: "running" | "starting";
}

/** `local-daemon` presents the probe's daemon as the one the desktop app manages. */
export function fakeDesktopScenario(
  name: FakeDesktopScenarioName,
  daemon: { serverId: string; url: string },
): FakeDesktopScenario {
  switch (name) {
    case "local-daemon":
      return {
        platform: "linux",
        serverId: daemon.serverId,
        listen: new URL(daemon.url).host,
        daemon: "running",
      };
    case "daemon-starting":
      return {
        platform: "darwin",
        serverId: "srv_desktop_pending",
        listen: null,
        daemon: "starting",
      };
  }
}

/**
 * Poses as the desktop app's preload bridge. Runs in the page through `addInitScript`, so it
 * must not use anything from module scope; only types are imported, and typecheck fails when
 * `DesktopHostBridge` changes underneath it.
 */
export function installFakeDesktopBridge(scenario: FakeDesktopScenario): void {
  const bridge: DesktopHostBridge = {
    platform: scenario.platform,
    invoke: async (command) => {
      if (command === "start_desktop_daemon" && scenario.daemon === "starting") {
        return await new Promise(() => {
          // Keeps the daemon starting for the rest of the probe.
        });
      }
      if (
        command === "desktop_daemon_status" ||
        command === "start_desktop_daemon" ||
        command === "restart_desktop_daemon"
      ) {
        return {
          serverId: scenario.serverId,
          status: scenario.daemon,
          listen: scenario.listen,
          hostname: null,
          pid: null,
          home: "",
          version: null,
          desktopManaged: true,
          error: null,
        };
      }
      if (command === "desktop_daemon_logs") return { logPath: "", contents: "" };
      return null;
    },
    getPendingOpenProject: async () => null,
    events: { on: async () => () => undefined },
  };
  window.paseoDesktop = bridge;
}
