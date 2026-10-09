import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type DesktopNixUpdateResult } from "@/desktop/host";
import { confirmDialog } from "@/utils/confirm-dialog";
import { settingsStyles } from "@/styles/settings";
import { formatVersionWithPrefix } from "./desktop-updates";
import { useNixDesktopUpdater, type NixUpdateAction } from "./use-nix-desktop-updater";

const progressTranslationKeys: Record<NixUpdateAction, string> = {
  check: "checkingInProgress",
  status: "checkingInProgress",
  stage: "stagingInProgress",
  activate: "activatingInProgress",
  rollback: "rollbackInProgress",
};

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
});

function getStatusMessage(input: {
  isNixInvalid: boolean;
  error: string | null;
  busy: NixUpdateAction | null;
  result: DesktopNixUpdateResult | null;
  t: (key: string) => string;
}): string {
  if (input.isNixInvalid) return input.t("settings.about.nixUpdates.invalidMarker");
  if (input.error) return input.error;
  if (input.busy) {
    return input.t(`settings.about.nixUpdates.${progressTranslationKeys[input.busy]}`);
  }
  return input.result?.message ?? input.t("settings.about.nixUpdates.ready");
}

function NixUpdateDetails({ result }: { result: DesktopNixUpdateResult | null }) {
  const { t } = useTranslation();
  const running = result?.running;
  const active = result?.active ?? null;
  const staged = result?.staged ?? null;
  const latest = result?.latest ?? null;
  const restartRequired = Boolean(active && running && active.outputPath !== running.outputPath);

  return (
    <>
      <Text style={settingsStyles.rowHint}>
        {t("settings.about.nixUpdates.running", {
          version: formatVersionWithPrefix(running?.version),
        })}
      </Text>
      <Text style={settingsStyles.rowHint}>
        {t("settings.about.nixUpdates.active", {
          version: formatVersionWithPrefix(active?.packageVersion),
          sequence: active?.releaseSequence ?? "—",
        })}
      </Text>
      <Text style={settingsStyles.rowHint}>
        {t("settings.about.nixUpdates.staged", {
          version: formatVersionWithPrefix(staged?.packageVersion),
          sequence: staged?.releaseSequence ?? "—",
        })}
      </Text>
      {latest ? (
        <Text style={settingsStyles.rowHint}>
          {t("settings.about.nixUpdates.latest", {
            version: formatVersionWithPrefix(latest.packageVersion),
            sequence: latest.releaseSequence,
          })}
        </Text>
      ) : null}
      {restartRequired ? (
        <Text style={settingsStyles.rowHint}>{t("settings.about.nixUpdates.restartRequired")}</Text>
      ) : null}
    </>
  );
}

interface NixUpdateActionsProps {
  busy: NixUpdateAction | null;
  isNixInvalid: boolean;
  canStage: boolean;
  canActivate: boolean;
  canRollback: boolean;
  onCheck(): void;
  onStage(): void;
  onActivate(): void;
  onRollback(): void;
}

function NixUpdateActions(props: NixUpdateActionsProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.actions}>
      <Button
        variant="secondary"
        size="sm"
        disabled={props.busy !== null || props.isNixInvalid}
        onPress={props.onCheck}
      >
        {t("settings.about.nixUpdates.check")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={props.busy !== null || !props.canStage}
        onPress={props.onStage}
      >
        {t("settings.about.nixUpdates.stage")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={props.busy !== null || !props.canActivate}
        onPress={props.onActivate}
      >
        {t("settings.about.nixUpdates.activate")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={props.busy !== null || !props.canRollback}
        onPress={props.onRollback}
      >
        {t("settings.about.nixUpdates.rollback")}
      </Button>
    </View>
  );
}

export function NixDesktopAppUpdateRow() {
  const { t } = useTranslation();
  const { result, error, busy, run } = useNixDesktopUpdater();
  const isNixInvalid = getDesktopHost()?.installationMode === "nix-invalid";
  const active = result?.active ?? null;
  const staged = result?.staged ?? null;
  const latest = result?.latest ?? null;
  const canReplaceStaged =
    staged === null || (latest !== null && latest.releaseSequence > staged.releaseSequence);
  const canStage = !isNixInvalid && result?.canStage === true && canReplaceStaged;
  const canActivate = !isNixInvalid && staged !== null;
  const canRollback = !isNixInvalid && active !== null;

  const confirmAndRun = useCallback(
    async (action: "activate" | "rollback") => {
      const confirmed = await confirmDialog({
        title: t(`settings.about.nixUpdates.${action}ConfirmTitle`),
        message: t(`settings.about.nixUpdates.${action}ConfirmMessage`),
        confirmLabel: t(`settings.about.nixUpdates.${action}`),
        cancelLabel: t("common.actions.cancel"),
      });
      if (confirmed) await run(action);
    },
    [run, t],
  );
  const onCheck = useCallback(() => void run("check"), [run]);
  const onStage = useCallback(() => void run("stage"), [run]);
  const onActivate = useCallback(() => void confirmAndRun("activate"), [confirmAndRun]);
  const onRollback = useCallback(() => void confirmAndRun("rollback"), [confirmAndRun]);
  const statusMessage = getStatusMessage({ isNixInvalid, error, busy, result, t });

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="nix-desktop-update-row">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.about.nixUpdates.label")}</Text>
        <NixUpdateDetails result={result} />
        <Text style={settingsStyles.rowHint} testID="nix-desktop-update-status">
          {statusMessage}
        </Text>
        <NixUpdateActions
          busy={busy}
          isNixInvalid={isNixInvalid}
          canStage={canStage}
          canActivate={canActivate}
          canRollback={canRollback}
          onCheck={onCheck}
          onStage={onStage}
          onActivate={onActivate}
          onRollback={onRollback}
        />
      </View>
    </View>
  );
}
