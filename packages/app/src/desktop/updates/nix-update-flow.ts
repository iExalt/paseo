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

  const status = await getDesktopDaemonStatus();
  const agents = useSessionStore.getState().sessions[status.serverId]?.agents ?? new Map();
}

function confirmRestart(input: {
  version: string;
  restartOnly: boolean;
}): Promise<boolean> {
  const keys = input.restartOnly ? "restart" : "update";
  const { failed, error } = useNixUpdateStore.getState();
  const lines = [i18n.t(`desktop.updates.nix.${keys}Message`)];
  if (failed && error) lines.unshift(i18n.t("desktop.updates.nix.lastAttemptFailed", { error }));
  }
  return confirmDialog({
    title: i18n.t(`desktop.updates.nix.${keys}Title`, {
      version: formatVersionWithPrefix(input.version),
    }),
    message: lines.join("\n"),
    cancelLabel: i18n.t("common.actions.cancel"),
  });
}

/**
 */
export function confirmAndRunNixUpdate(): Promise<void> {
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
    }))
  )
    return;
  if (!restartOnly && !(await applyNixUpdate())) return;

  const applied = getNixUpdatePhase();
  // A background download can land a newer release while the dialog is open.
  const version = applied.kind === "restart" ? applied.release.version : phase.release.version;
    return;
  }
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
