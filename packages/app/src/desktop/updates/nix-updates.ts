import { compareForkVersions } from "@getpaseo/protocol/fork-version";
import { create } from "zustand";
import {
  getDesktopHost,
  type DesktopNixReleaseSummary,
  type DesktopNixUpdateResult,
} from "@/desktop/host";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { isVersionMismatch } from "./desktop-updates";

export const NIX_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type NixUpdatePhase =
  | { kind: "unknown" }
  | { kind: "current" }
  | { kind: "available"; release: DesktopNixReleaseSummary }
  | { kind: "ready"; release: DesktopNixReleaseSummary }
  | { kind: "restart"; release: DesktopNixReleaseSummary };

export type NixUpdateBusy = "checking" | "downloading" | "applying" | "restarting";

export interface NixLocalDaemon {
  version: string | null;
  desktopManaged: boolean;
}

export interface NixUpdateFacts {
  result: DesktopNixUpdateResult | null;
  latest: DesktopNixReleaseSummary | null;
  daemon: NixLocalDaemon | null;
}

interface NixUpdateState extends NixUpdateFacts {
  canStage: boolean;
  busy: NixUpdateBusy | null;
  error: string | null;
  /** Set when an update the user asked for failed, so the sidebar can flag it. */
  failed: boolean;
  /** A confirm-apply-restart flow is open; other entry points and background checks wait. */
  flowActive: boolean;
  lastCheckedAt: number | null;
}

export const useNixUpdateStore = create<NixUpdateState>(() => ({
  result: null,
  latest: null,
  daemon: null,
  canStage: false,
  busy: null,
  error: null,
  failed: false,
  flowActive: false,
  lastCheckedAt: null,
}));

function isNewer(
  release: DesktopNixReleaseSummary,
  than: DesktopNixReleaseSummary | null | undefined,
): boolean {
  return !than || compareForkVersions(release.version, than.version) > 0;
}

export function resolveNixUpdatePhase(facts: NixUpdateFacts): NixUpdatePhase {
  const { result, latest, daemon } = facts;
  if (!result) return { kind: "unknown" };
  const { active, running } = result;
  const staged = result.staged ?? null;
  if (staged && isNewer(staged, active)) return { kind: "ready", release: staged };
  if (active && active.outputPath !== running.outputPath) {
    return { kind: "restart", release: active };
  }
  // The desktop daemon outlives the app, so an app-only relaunch can leave it on the old release.
  if (active && daemon?.desktopManaged && isVersionMismatch(active.version, daemon.version)) {
    return { kind: "restart", release: active };
  }
  if (latest && isNewer(latest, active)) return { kind: "available", release: latest };
  return { kind: "current" };
}

export function shouldDownloadInBackground(state: NixUpdateState): boolean {
  const { latest, result } = state;
  if (!state.canStage || !latest || !result) return false;
  return isNewer(latest, result.staged ?? result.active);
}

export function getNixUpdatePhase(): NixUpdatePhase {
  return resolveNixUpdatePhase(useNixUpdateStore.getState());
}

export function useNixUpdatePhase(): NixUpdatePhase {
  const result = useNixUpdateStore((state) => state.result);
  const latest = useNixUpdateStore((state) => state.latest);
  const daemon = useNixUpdateStore((state) => state.daemon);
  return resolveNixUpdatePhase({ result, latest, daemon });
}

type NixCommand = "status" | "check" | "stage" | "activate";

async function runCommand(command: NixCommand): Promise<DesktopNixUpdateResult> {
  const method = getDesktopHost()?.nixUpdates?.[command];
  if (!method) throw new Error("The managed Nix update bridge is unavailable.");
  return await method();
}

function absorb(result: DesktopNixUpdateResult): void {
  useNixUpdateStore.setState((state) => ({
    result,
    // A failed release lookup omits latest; keep the last good one.
    latest: result.latest ?? state.latest,
    canStage: result.canStage ?? state.canStage,
    lastCheckedAt: result.action === "check" ? Date.now() : state.lastCheckedAt,
    error: result.latestError ?? null,
  }));
}

async function refreshDaemon(): Promise<void> {
  try {
    const status = await getDesktopDaemonStatus();
    useNixUpdateStore.setState({
      daemon:
        status.status === "running"
          ? { version: status.version, desktopManaged: status.desktopManaged }
          : null,
    });
  } catch {
    // The daemon check only refines the restart prompt; the update facts still stand.
  }
}

// Every updater command goes through one queue so a background download and a
// user's update never run the CLI concurrently.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

async function step(busy: NixUpdateBusy, command: NixCommand): Promise<void> {
  useNixUpdateStore.setState({ busy });
  try {
    absorb(await runCommand(command));
  } finally {
    useNixUpdateStore.setState({ busy: null });
  }
}

function recordError(error: unknown, userInitiated: boolean): void {
  useNixUpdateStore.setState({
    error: error instanceof Error ? error.message : String(error),
    failed: userInitiated,
  });
}

export function refreshNixUpdateStatus(): Promise<void> {
  return enqueue(async () => {
    try {
      await step("checking", "status");
      await refreshDaemon();
    } catch (error) {
      recordError(error, false);
    }
  });
}

/** Checks for a release and, when one is newer, downloads it without applying it. */
export function checkForNixUpdate({ userInitiated }: { userInitiated: boolean }): Promise<void> {
  return enqueue(async () => {
    if (!userInitiated && useNixUpdateStore.getState().flowActive) return;
    try {
      useNixUpdateStore.setState({ failed: false });
      await step("checking", "check");
      await refreshDaemon();
      if (shouldDownloadInBackground(useNixUpdateStore.getState())) {
        await step("downloading", "stage");
      }
    } catch (error) {
      recordError(error, userInitiated);
    }
  });
}

/** Downloads the update if needed and makes it the next release to launch. */
export function applyNixUpdate(): Promise<boolean> {
  return enqueue(async () => {
    try {
      useNixUpdateStore.setState({ failed: false });
      if (getNixUpdatePhase().kind === "available") await step("downloading", "stage");
      if (getNixUpdatePhase().kind === "ready") await step("applying", "activate");
      return getNixUpdatePhase().kind === "restart";
    } catch (error) {
      recordError(error, true);
      return false;
    }
  });
}

export function restartIntoNixUpdate(
  confirmedDaemon: {
    pid: number;
    startedAt: string;
  } | null,
): Promise<void> {
  return enqueue(async () => {
    const restart = getDesktopHost()?.nixUpdates?.restart;
    try {
      if (!restart) throw new Error("The managed Nix update bridge is unavailable.");
      useNixUpdateStore.setState({ busy: "restarting", failed: false });
      await restart(confirmedDaemon ?? undefined);
    } catch (error) {
      useNixUpdateStore.setState({ busy: null });
      recordError(error, true);
    }
  });
}
