import { useCallback, useMemo } from "react";
import { Platform, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { FONT_SIZE } from "@/styles/theme";
import { turnSourceDisplay } from "./turn-source-display";

const SNAP_POINTS = ["70%", "95%"];

/**
 * A turn's Markdown source in a read-only input. Native text selection cannot map back
 * to Markdown, so selecting here is how part of a reply is copied with its syntax.
 * iOS uses a read-only input, since its Text selection only copies everything. Android
 * uses selectable Text, since a read-only input there is disabled and cannot select.
 */
const SELECTABLE_TEXT = Platform.OS === "android";

export function TurnSourceSheet({
  visible,
  content,
  onClose,
}: {
  visible: boolean;
  content: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const display = useMemo(() => turnSourceDisplay(content), [content]);
  const header: SheetHeader = useMemo(() => ({ title: t("message.actions.selectText") }), [t]);
  const handleCopyAll = useCallback(() => {
    void writeMarkdownToRichClipboard(content, getDefaultMarkdownClipboardEnvironment());
    onClose();
  }, [content, onClose]);
  const footer = useMemo(
    () => (
      <Button variant="outline" size="sm" onPress={handleCopyAll} testID="turn-source-copy-all">
        {t("message.actions.copyTurn")}
      </Button>
    ),
    [handleCopyAll, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      scrollable={SELECTABLE_TEXT}
      footer={footer}
      testID="turn-source-sheet"
    >
      {display.truncated ? (
        <Text style={styles.hint}>{t("message.actions.selectTextTruncated")}</Text>
      ) : null}
      {SELECTABLE_TEXT ? (
        <Text selectable style={styles.source} testID="turn-source-text">
          {display.text}
        </Text>
      ) : (
        <EditingTextInput
          initialValue={display.text}
          readOnly
          multiline
          scrollEnabled
          style={styles.source}
          textAlignVertical="top"
          testID="turn-source-text"
        />
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  hint: {
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  source: {
    flex: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: FONT_SIZE.code,
    padding: theme.spacing[3],
  },
}));
