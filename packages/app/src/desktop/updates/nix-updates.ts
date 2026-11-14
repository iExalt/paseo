import { compareForkVersions } from "@getpaseo/protocol/fork-version";
import { create } from "zustand";
import {
  getDesktopHost,
  type DesktopNixReleaseSummary,
  type DesktopNixUpdateResult,
} from "@/desktop/host";

export const NIX_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type NixUpdatePhase =
  | { kind: "unknown" }
  | { kind: "current" }
  | { kind: "available"; release: DesktopNixReleaseSummary }
  | { kind: "ready"; release: DesktopNixReleaseSummary }
  | { kind: "restart"; release: DesktopNixReleaseSummary };

export type NixUpdateBusy = "checking" | "downloading" | "applying" | "restarting";

export interface NixUpdateFacts {
  result: DesktopNixUpdateResult | null;
  latest: DesktopNixReleaseSummary | null;
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
  const { result, latest } = facts;
  if (!result) return { kind: "unknown" };
  const { active, running } = result;
  const staged = result.staged ?? null;
  if (staged && isNewer(staged, active)) {
    // A release published after the download supersedes it; staging that one replaces it.
    if (latest && isNewer(latest, staged)) return { kind: "available", release: latest };
    return { kind: "ready", release: staged };
  }
  if (active && active.outputPath !== running.outputPath) {
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
  return resolveNixUpdatePhase({ result, latest });
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

export function restartIntoNixUpdate(): Promise<void> {
  return enqueue(async () => {
    const restart = getDesktopHost()?.nixUpdates?.restart;
    try {
      if (!restart) throw new Error("The managed Nix update bridge is unavailable.");
      useNixUpdateStore.setState({ busy: "restarting", failed: false });
      await restart();
    } catch (error) {
      useNixUpdateStore.setState({ busy: null });
      recordError(error, true);
    }
  });
}
