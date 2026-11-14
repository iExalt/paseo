import { i18n } from "@/i18n/i18next";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatVersionWithPrefix } from "./desktop-updates";
import {
  applyNixUpdate,
  checkForNixUpdate,
  getNixUpdatePhase,
  restartIntoNixUpdate,
  useNixUpdateStore,
} from "./nix-updates";

/** Running agents on the local daemon; they keep running through the restart. */
async function countRunningAgents(): Promise<number> {
  const status = await getDesktopDaemonStatus();
  if (status.status !== "running") return 0;
  const agents = useSessionStore.getState().sessions[status.serverId]?.agents ?? new Map();
  return [...agents.values()].filter((agent) => agent.status === "running").length;
}

function confirmRestart(input: {
  version: string;
  restartOnly: boolean;
  runningAgents: number;
}): Promise<boolean> {
  const keys = input.restartOnly ? "restart" : "update";
  const { failed, error } = useNixUpdateStore.getState();
  const lines = [i18n.t(`desktop.updates.nix.${keys}Message`)];
  if (failed && error) lines.unshift(i18n.t("desktop.updates.nix.lastAttemptFailed", { error }));
  if (input.runningAgents > 0) {
    lines.push(i18n.t("desktop.updates.nix.agentsKeepRunning", { count: input.runningAgents }));
  }
  return confirmDialog({
    title: i18n.t(`desktop.updates.nix.${keys}Title`, {
      version: formatVersionWithPrefix(input.version),
    }),
    message: lines.join("\n"),
    confirmLabel: i18n.t(`desktop.updates.nix.${keys}Confirm`),
    cancelLabel: i18n.t("common.actions.cancel"),
  });
}

/**
 * Confirms, applies any pending update, and restarts Paseo. The daemon keeps running and
 * upgrades itself once its agents are idle. Asks again if a newer release lands meanwhile.
 */
export function confirmAndRunNixUpdate(): Promise<void> {
  // The sidebar and Settings can both start this; run one restart at a time.
  if (inFlight) return inFlight;
  useNixUpdateStore.setState({ flowActive: true });
  inFlight = runUpdateFlow().finally(() => {
    inFlight = null;
    useNixUpdateStore.setState({ flowActive: false });
  });
  return inFlight;
}

let inFlight: Promise<void> | null = null;

async function runUpdateFlow(): Promise<void> {
  const phase = getNixUpdatePhase();
  if (phase.kind !== "available" && phase.kind !== "ready" && phase.kind !== "restart") return;
  const restartOnly = phase.kind === "restart";
  if (
    !(await confirmRestart({
      version: phase.release.version,
      restartOnly,
      runningAgents: await countRunningAgents(),
    }))
  )
    return;
  if (!restartOnly && !(await applyNixUpdate())) return;

  const applied = getNixUpdatePhase();
  // A background download can land a newer release while the dialog is open.
  const version = applied.kind === "restart" ? applied.release.version : phase.release.version;
  if (
    version !== phase.release.version &&
    !(await confirmRestart({
      version,
      restartOnly: true,
      runningAgents: await countRunningAgents(),
    }))
  ) {
    return;
  }
  await restartIntoNixUpdate();
}

/** Sidebar entry point: runs the update, or retries a failed check. */
export async function handleNixUpdatePress(): Promise<void> {
  const phase = getNixUpdatePhase();
  if (phase.kind === "available" || phase.kind === "ready" || phase.kind === "restart") {
    await confirmAndRunNixUpdate();
    return;
  }
  const { error } = useNixUpdateStore.getState();
  const retry = await confirmDialog({
    title: i18n.t("desktop.updates.nix.failedTitle"),
    message: error ?? i18n.t("desktop.updates.nix.failedTooltip"),
    confirmLabel: i18n.t("desktop.updates.nix.tryAgain"),
    cancelLabel: i18n.t("common.actions.cancel"),
  });
  if (retry) await checkForNixUpdate({ userInitiated: true });
}
