import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { forkUpdater, useForkUpdate } from "./updater";

export function ForkAndroidUpdateRow() {
  const { t } = useTranslation();
  const shown = useForkUpdate((view) => view.shown);
  const message = useForkUpdate((view) => view.message);
  const labelKey = useForkUpdate((view) => view.row.labelKey);
  const disabled = useForkUpdate((view) => view.row.disabled);

  useEffect(() => forkUpdater.start(), []);
  const onPress = useCallback(() => void forkUpdater.send({ type: "press", via: "row" }), []);

  if (!shown) {
    return null;
  }

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]} testID="fork-android-update-row">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.about.forkUpdates.label")}</Text>
        <Text style={settingsStyles.rowHint} testID="fork-android-update-status">
          {t(message.key, { ...message.params, defaultValue: message.defaultValue })}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={onPress}
        disabled={disabled}
        testID="fork-android-update-action"
      >
        {t(labelKey)}
      </Button>
    </View>
  );
}
