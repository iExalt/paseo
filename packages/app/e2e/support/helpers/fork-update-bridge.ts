import type { Page } from "@playwright/test";
export type ForkUpdateFixture =
  | "windows"
  | "windows-error"
  | "macos-nix"
  | "linux-nix"
  | "linux-bootstrap"
  | "nix-invalid"
  | "browser";
/** Fixture bridge only: never launches an installer, daemon, or real update request. */
export function forkUpdateBridgeFixture(mode: ForkUpdateFixture) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  Object.assign(window, { forkUpdateFixtureCalls: calls });
  if (mode === "browser") return;
  const current = {
    version: "0.23.1",
    releaseTag: "paseo-v0.23.1",
    outputPath: `/nix/store/${"a".repeat(32)}-paseo-desktop-0.23.1`,
  };
  const next = {
    version: "0.23.2",
    releaseTag: "paseo-v0.23.2",
    outputPath: `/nix/store/${"b".repeat(32)}-paseo-desktop-0.23.2`,
  };
  let active = current;
  let staged: typeof current | null = null;
  const nix = async (command: string) => {
    calls.push({ command: `nix_update_${command}` });
    if (mode === "linux-bootstrap")
      throw new Error(
        "Linux fork updates require one bootstrap: run the installed paseo-nix-update bootstrap, then use its dedicated launcher",
      );
    if (command === "stage") staged = next;
    if (command === "activate") {
      active = next;
      staged = null;
    }
    return {
      ok: true as const,
      action: command as "check" | "status" | "stage" | "activate",
      active,
      staged,
      latest: next,
      highWaterVersion: active.version,
      canStage: active.version !== next.version,
      running: { version: current.version, outputPath: current.outputPath },
    };
  };
  let platform = "linux";
  let installationMode: "nix" | "electron" | "nix-invalid" = "nix";
  if (mode.startsWith("windows")) {
    platform = "win32";
    installationMode = "electron";
  } else if (mode === "macos-nix") platform = "darwin";
  else if (mode === "nix-invalid") installationMode = "nix-invalid";
  window.paseoDesktop = {
    platform,
    installationMode,
    getPendingOpenProject: async () => null,
    events: { on: async () => () => {} },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "get_desktop_settings" || command === "migrate_legacy_desktop_settings")
        return {
          releaseChannel: "beta",
          notifications: { playSound: false },
          daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
        };
      if (command === "desktop_get_runtime_info")
        return { appVersion: current.version, runningUnderARM64Translation: false };
      if (command === "desktop_daemon_logs") return { logPath: "", contents: "" };
      if (command === "desktop_daemon_status")
        return {
          status: "stopped",
          pid: null,
          serverId: "",
          version: null,
          desktopManaged: false,
          ownedByDesktop: false,
        };
      if (command === "check_app_update")
        return {
          currentVersion: current.version,
          latestVersion: next.version,
          hasUpdate: mode !== "windows-error",
          readyToInstall: mode !== "windows-error",
          body: null,
          date: null,
          errorMessage:
            mode === "windows-error"
              ? "Fork update metadata is unavailable. Retry when GitHub is reachable."
              : null,
        };
      if (command === "install_app_update")
        return {
          installed: false,
          version: current.version,
          message: "Fork update is waiting for active agents to finish.",
        };
      if (command === "desktop_get_system_idle_time") return 0;
      if (command === "get_local_daemon_version") return { version: current.version, error: null };
      return null;
    },
    nixUpdates: {
      check: () => nix("check"),
      status: () => nix("status"),
      stage: () => nix("stage"),
      activate: () => nix("activate"),
      rollback: () => nix("rollback"),
      restart: async () => {
        calls.push({ command: "nix_update_restart" });
      },
    },
  };
}
export async function installForkUpdateFixture(page: Page, mode: ForkUpdateFixture) {
  await page.addInitScript(forkUpdateBridgeFixture, mode);
}
