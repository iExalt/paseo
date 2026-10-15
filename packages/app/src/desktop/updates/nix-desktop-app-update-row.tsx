import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { settingsStyles } from "@/styles/settings";
import { formatVersionWithPrefix } from "./desktop-updates";
import { confirmAndRunNixUpdate } from "./nix-update-flow";
import {
  applyNixUpdate,
  checkForNixUpdate,
  refreshNixUpdateStatus,
  useNixUpdatePhase,
  useNixUpdateStore,
  type NixUpdateBusy,
  type NixUpdatePhase,
} from "./nix-updates";

type Translate = ReturnType<typeof useTranslation>["t"];

function describeState(input: {
  t: Translate;
  phase: NixUpdatePhase;
  busy: NixUpdateBusy | null;
  error: string | null;
  lastCheckedAt: number | null;
}): string {
  const { t, phase, busy } = input;
  const version =
    phase.kind === "unknown" || phase.kind === "current"
      ? ""
      : formatVersionWithPrefix(phase.release.version);
  if (busy === "checking") return t("desktop.updates.nix.checking");
  if (busy === "downloading") return t("desktop.updates.nix.downloading", { version });
  if (busy === "applying") return t("desktop.updates.nix.applying", { version });
  if (busy === "restarting") return t("desktop.updates.nix.restarting");
  if (input.error) return t("desktop.updates.nix.failed", { error: input.error });
  if (phase.kind === "available") return t("desktop.updates.nix.available", { version });
  if (phase.kind === "ready") return t("desktop.updates.nix.ready", { version });
  if (phase.kind === "restart") return t("desktop.updates.nix.restartRequired", { version });
  if (phase.kind === "current" && input.lastCheckedAt !== null) {
    const time = new Date(input.lastCheckedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return t("desktop.updates.nix.upToDate", { time });
  }
  return t("desktop.updates.nix.notChecked");
}

function actionFor(phase: NixUpdatePhase): "check" | "update" | "restart" {
  if (phase.kind === "available" || phase.kind === "ready") return "update";
  if (phase.kind === "restart") return "restart";
  return "check";
}

export function NixDesktopAppUpdateRow({ appVersion = null }: { appVersion?: string | null }) {
  const { t } = useTranslation();
  const phase = useNixUpdatePhase();
  const busy = useNixUpdateStore((state) => state.busy);
  const error = useNixUpdateStore((state) => state.error);
  const lastCheckedAt = useNixUpdateStore((state) => state.lastCheckedAt);
  const runningVersion = useNixUpdateStore((state) => state.result?.running.version ?? null);
  const isNixInvalid = getDesktopHost()?.installationMode === "nix-invalid";
  const action = actionFor(phase);

  useEffect(() => {
    if (!isNixInvalid) void refreshNixUpdateStatus();
  }, [isNixInvalid]);

  const onPress = useCallback(() => {
    if (action === "update") void applyNixUpdate();
    else if (action === "restart") void confirmAndRunNixUpdate();
    else void checkForNixUpdate({ userInitiated: true });
  }, [action]);

  const state = isNixInvalid
    ? t("settings.about.nixUpdates.invalidMarker")
    : describeState({ t, phase, busy, error, lastCheckedAt });
  // The running version is local, so show it even when no updater call succeeded.
  const version = formatVersionWithPrefix(runningVersion ?? appVersion);

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="nix-desktop-update-row">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.about.nixUpdates.label")}</Text>
        <Text style={settingsStyles.rowHint} testID="nix-desktop-update-status">
          {`${version} · ${state}`}
        </Text>
      </View>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy !== null || isNixInvalid}
        onPress={onPress}
        testID="nix-desktop-update-action"
      >
        {t(`desktop.updates.nix.${action}Action`)}
      </Button>
    </View>
  );
}
