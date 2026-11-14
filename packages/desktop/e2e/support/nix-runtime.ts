import type { Page } from "@playwright/test";
import { getE2EDaemonPort } from "../../../app/e2e/support/helpers/daemon-port";
import { installDesktopRuntime } from "./runtime";

export async function installNixRuntime(
  page: Page,
  hostId: string,
  selectedVersion = "0.23.0",
  initialUpgradePhase: "waiting" | "failed" = "waiting",
) {
  await installDesktopRuntime(page, {
    serverId: hostId,
    confirmShouldAccept: true,
    daemonPid: 42,
    manageBuiltInDaemon: true,
    daemonVersion: "0.22.0",
    daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
  });
  await page.addInitScript(
    ({ serverId, activeVersion, initialPhase }) => {
      type Phase = "checking" | "waiting" | "upgrading" | "failed" | "unsupported" | null;
      const fixture = window as unknown as {
        paseoDesktop: {
          installationMode: string;
          nixUpdates?: Record<string, () => Promise<unknown>>;
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
          events: {
            on: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
          };
        };
        __setDaemonUpgrade: (phase: Phase, version?: string) => void;
        __updateCommands: string[];
      };
      const bridge = fixture.paseoDesktop;
      const invoke = bridge.invoke;
      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      let phase: Phase = initialPhase;
      let version = "0.22.0";
      fixture.__updateCommands = [];
      fixture.__setDaemonUpgrade = (next, nextVersion) => {
        phase = next;
        if (nextVersion) version = nextVersion;
        for (const handler of listeners.get("desktop-daemon-upgrade-changed") ?? []) handler({});
      };
      bridge.installationMode = "nix";
      bridge.events.on = async (event, handler) => {
        const handlers = listeners.get(event) ?? new Set();
        handlers.add(handler);
        listeners.set(event, handlers);
        return () => {
          handlers.delete(handler);
        };
      };
      const release = (value: string) => ({
        releaseTag: `paseo-v${value}`,
        version: value,
        outputPath: `/nix/store/${"a".repeat(32)}-paseo-${value}`,
      });
      bridge.invoke = async (command, args) => {
        fixture.__updateCommands.push(command);
        if (command === "desktop_daemon_status") {
          const status = (await invoke(command, args)) as Record<string, unknown>;
          return {
            ...status,
            version,
            desktopManaged: true,
            ...(phase === "failed" || phase === "upgrading"
              ? {
                  status: "stopped",
                  serverId: "",
                  pid: null,
                  startedAt: null,
                  desktopManaged: false,
                }
              : {}),
            upgrade: phase
              ? {
                  phase,
                  serverId,
                  pid: 42,
                  startedAt: "2026-09-01T00:00:00.000Z",
                  targetVersion: "0.23.0",
                  error: phase === "failed" ? "Test update unavailable" : null,
                }
              : null,
          };
        }
        if (command === "cli_daemon_status")
          return JSON.stringify(await bridge.invoke("desktop_daemon_status"), null, 2);
        if (command.startsWith("nix_update_") && command !== "nix_update_restart")
          return {
            ok: true,
            action: command.slice("nix_update_".length),
            active: release(activeVersion),
            staged: null,
            running: { version: "0.23.0", outputPath: release("0.23.0").outputPath },
            latest: release(activeVersion),
            highWaterVersion: activeVersion,
            canStage: false,
          };
        return invoke(command, args);
      };
      const nixUpdates: Record<string, () => Promise<unknown>> = {};
      for (const action of ["check", "status", "stage", "activate", "rollback", "restart"]) {
        nixUpdates[action] = () => bridge.invoke(`nix_update_${action}`);
      }
      bridge.nixUpdates = nixUpdates;
    },
    { serverId: hostId, activeVersion: selectedVersion, initialPhase: initialUpgradePhase },
  );
}

export async function setDaemonUpgrade(
  page: Page,
  nextPhase: "waiting" | "upgrading" | "failed" | null,
  nextVersion?: string,
) {
  await page.evaluate(
    ({ phase, version }) => {
      (
        window as unknown as {
          __setDaemonUpgrade: (phase: string | null, version?: string) => void;
        }
      ).__setDaemonUpgrade(phase, version);
    },
    { phase: nextPhase, version: nextVersion },
  );
}
