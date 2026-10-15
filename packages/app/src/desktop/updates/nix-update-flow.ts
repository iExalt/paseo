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

const LISTED_AGENTS = 3;

interface RestartTarget {
  daemon: { pid: number; startedAt: string } | null;
  /** Running agents on the local daemon, which the restart stops. */
  agents: { id: string; label: string }[];
}

async function captureRestartTarget(): Promise<RestartTarget> {
  const status = await getDesktopDaemonStatus();
  if (status.status !== "running" || !status.desktopManaged || !status.pid || !status.startedAt) {
    return { daemon: null, agents: [] };
  }
  const agents = useSessionStore.getState().sessions[status.serverId]?.agents ?? new Map();
  return {
    daemon: { pid: status.pid, startedAt: status.startedAt },
    agents: [...agents.values()]
      .filter((agent) => agent.status === "running")
      .map((agent) => ({ id: agent.id, label: agent.title ?? agent.id })),
  };
}

function confirmRestart(input: {
  version: string;
  restartOnly: boolean;
  target: RestartTarget;
}): Promise<boolean> {
  const { agents } = input.target;
  const keys = input.restartOnly ? "restart" : "update";
  const { failed, error } = useNixUpdateStore.getState();
  const lines = [i18n.t(`desktop.updates.nix.${keys}Message`)];
  if (failed && error) lines.unshift(i18n.t("desktop.updates.nix.lastAttemptFailed", { error }));
  if (agents.length > 0) {
    lines.push(i18n.t("desktop.updates.nix.agentsStop", { count: agents.length }));
    lines.push(...agents.slice(0, LISTED_AGENTS).map((agent) => `• ${agent.label}`));
    if (agents.length > LISTED_AGENTS) {
      lines.push(
        i18n.t("desktop.updates.nix.agentsMore", { count: agents.length - LISTED_AGENTS }),
      );
    }
  }
  return confirmDialog({
    title: i18n.t(`desktop.updates.nix.${keys}Title`, {
      version: formatVersionWithPrefix(input.version),
    }),
    message: lines.join("\n"),
    confirmLabel: i18n.t(
      agents.length > 0
        ? `desktop.updates.nix.${keys}StopAgents`
        : `desktop.updates.nix.${keys}Confirm`,
    ),
    cancelLabel: i18n.t("common.actions.cancel"),
    destructive: agents.length > 0,
  });
}

/**
 * Confirms, applies any pending update, and restarts Paseo with its daemon.
 * If an agent starts while the update downloads, asks again before restarting.
 */
export async function confirmAndRunNixUpdate(): Promise<void> {
  const phase = getNixUpdatePhase();
  if (phase.kind !== "available" && phase.kind !== "ready" && phase.kind !== "restart") return;
  const restartOnly = phase.kind === "restart";
  const confirmedTarget = await captureRestartTarget();
  if (
    !(await confirmRestart({
      version: phase.release.version,
      restartOnly,
      target: confirmedTarget,
    }))
  )
    return;
  if (!restartOnly && !(await applyNixUpdate())) return;

  const target = restartOnly ? confirmedTarget : await captureRestartTarget();
  const confirmedIds = new Set(confirmedTarget.agents.map((agent) => agent.id));
  if (
    target.agents.some((agent) => !confirmedIds.has(agent.id)) &&
    !(await confirmRestart({ version: phase.release.version, restartOnly: true, target }))
  ) {
    return;
  }
  await restartIntoNixUpdate(target.daemon);
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
