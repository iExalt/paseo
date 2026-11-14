import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useBrowserStore } from "@/desktop/browser/store";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BROWSER_DATA_DESCRIPTION_KEY, clearBrowserData } from "./clear-browser-data";

export function BrowserDataSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const clearInFlightRef = useRef(false);
  const [isClearing, setIsClearing] = useState(false);

  const handleClear = useCallback(async () => {
    if (clearInFlightRef.current) {
      return;
    }

    clearInFlightRef.current = true;
    setIsClearing(true);
    try {
      const confirmed = await confirmDialog({
        title: t("settings.general.browserData.confirmTitle"),
        message: t("settings.general.browserData.confirmMessage"),
        confirmLabel: t("settings.general.browserData.clear"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      await clearBrowserData(Object.keys(useBrowserStore.getState().browsersById));
      toast.show(t("settings.general.browserData.success"), { variant: "success" });
    } catch {
      toast.error(t("settings.general.browserData.error"));
    } finally {
      clearInFlightRef.current = false;
      setIsClearing(false);
    }
  }, [t, toast]);
  const clearButtonLabel = isClearing
    ? t("settings.general.browserData.clearing")
    : t("settings.general.browserData.clear");

  return (
    <SettingsSection title={t("settings.general.browserData.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.general.browserData.siteData")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t(BROWSER_DATA_DESCRIPTION_KEY)}</Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            loading={isClearing}
            disabled={isClearing}
            onPress={handleClear}
          >
            {clearButtonLabel}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
