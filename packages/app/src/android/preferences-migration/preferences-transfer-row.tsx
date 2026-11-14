import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { applyPreferencesMigration } from "./journal";
import { reconcileImportedPreferences } from "./reconcile";
import {
  buildSelectedPreferencesImport,
  createPreferencesImportPreview,
  createPreferencesTransfer,
  parseTransferForPreview,
  type TransferSection,
} from "./transfer";
import { MAX_PREFERENCES_TRANSFER_BYTES } from "./schema";

const SECTION_KEYS: Record<TransferSection, string> = {
  appearance: "settings.about.preferenceTransfer.sections.appearance",
  defaults: "settings.about.preferenceTransfer.sections.defaults",
  changes: "settings.about.preferenceTransfer.sections.changes",
  editor: "settings.about.preferenceTransfer.sections.editor",
  shortcuts: "settings.about.preferenceTransfer.sections.shortcuts",
  sidebar: "settings.about.preferenceTransfer.sections.sidebar",
  panel: "settings.about.preferenceTransfer.sections.panel",
  workspace: "settings.about.preferenceTransfer.sections.workspace",
};

const ALL_SECTIONS = Object.keys(SECTION_KEYS) as TransferSection[];
const CHECKED_STATE = { checked: true } as const;
const UNCHECKED_STATE = { checked: false } as const;
const styles = StyleSheet.create((theme) => ({
  // Errors and the import preview sit under the row, on the row's content inset.
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  preview: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
}));

function SectionToggle({
  section,
  label,
  checked,
  onToggle,
}: {
  section: TransferSection;
  label: string;
  checked: boolean;
  onToggle: (section: TransferSection) => void;
}) {
  const handlePress = useCallback(() => onToggle(section), [onToggle, section]);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={checked ? CHECKED_STATE : UNCHECKED_STATE}
      onPress={handlePress}
      testID={`preferences-section-${section}`}
    >
      <Text style={styles.hint}>
        {checked ? "✓ " : "□ "}
        {label}
      </Text>
    </Pressable>
  );
}

function isCopiedCacheFile(file: File): boolean {
  const cacheUri = Paths.cache.uri;
  const cachePrefix = cacheUri.endsWith("/") ? cacheUri : `${cacheUri}/`;
  return file.uri.startsWith(cachePrefix);
}

export function PreferencesTransferRow({
  mode,
  daemonIds,
}: {
  mode: "bridge" | "receiver";
  daemonIds: readonly string[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [transfer, setTransfer] = useState<ReturnType<typeof parseTransferForPreview> | null>(null);
  const [selected, setSelected] = useState<TransferSection[]>(ALL_SECTIONS);
  // Which button shows the spinner; every action is disabled while one runs.
  const [busy, setBusy] = useState<"transfer" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportPreferences = useCallback(async () => {
    setBusy("transfer");
    setError(null);
    let file: File | null = null;
    let operationError: string | null = null;
    try {
      const contents = await createPreferencesTransfer({
        storage: AsyncStorage,
        configuredDaemonIds: daemonIds,
        sourceLabel: t("settings.about.preferenceTransfer.sourceLabel"),
      });
      const name = `paseo-preferences-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      file = new File(Paths.cache, name);
      file.write(contents);
      if (!(await Sharing.isAvailableAsync()))
        throw new Error(t("settings.about.preferenceTransfer.shareUnavailable"));
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        dialogTitle: t("settings.about.preferenceTransfer.exportTitle"),
      });
    } catch (cause) {
      operationError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      let cleanupError: string | null = null;
      try {
        if (file?.exists) file.delete();
      } catch (cause) {
        cleanupError = cause instanceof Error ? cause.message : String(cause);
      } finally {
        setBusy(null);
        if (operationError || cleanupError) setError(operationError ?? cleanupError);
      }
    }
  }, [daemonIds, t]);

  const chooseImport = useCallback(async () => {
    setBusy("transfer");
    setError(null);
    let copiedFile: File | null = null;
    let operationError: string | null = null;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/json",
        copyToCacheDirectory: true,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      copiedFile = new File(asset.uri);
      if (
        !Number.isFinite(copiedFile.size) ||
        copiedFile.size <= 0 ||
        copiedFile.size > MAX_PREFERENCES_TRANSFER_BYTES
      ) {
        throw new Error(t("settings.about.preferenceTransfer.tooLarge"));
      }
      const contents = await copiedFile.text();
      const parsed = parseTransferForPreview(contents);
      const nextPreview = createPreferencesImportPreview(parsed, daemonIds);
      setTransfer(parsed);
      setSelected(nextPreview.availableSections);
    } catch (cause) {
      operationError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      let cleanupError: string | null = null;
      try {
        if (copiedFile?.exists && isCopiedCacheFile(copiedFile)) copiedFile.delete();
      } catch (cause) {
        cleanupError = cause instanceof Error ? cause.message : String(cause);
      } finally {
        setBusy(null);
        if (operationError || cleanupError) setError(operationError ?? cleanupError);
      }
    }
  }, [daemonIds, t]);

  const confirmImport = useCallback(async () => {
    if (!transfer || selected.length === 0) return;
    setBusy("confirm");
    setError(null);
    try {
      const writes = await buildSelectedPreferencesImport({
        storage: AsyncStorage,
        transfer,
        destinationDaemonIds: daemonIds,
        selected,
      });
      await applyPreferencesMigration({
        storage: AsyncStorage,
        after: writes,
        reconcile: async () => {
          await reconcileImportedPreferences(queryClient, selected);
        },
      });
      setTransfer(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [daemonIds, queryClient, selected, transfer]);

  const toggleSection = useCallback((section: TransferSection) => {
    setSelected((current) =>
      current.includes(section)
        ? current.filter((item) => item !== section)
        : [...current, section],
    );
  }, []);
  const cancelImport = useCallback(() => setTransfer(null), []);

  const preview = transfer ? createPreferencesImportPreview(transfer, daemonIds) : null;

  const showDetails = error !== null || (preview !== null && transfer !== null);
  return (
          disabled={busy !== null}
          loading={busy === "transfer"}
      </View>
              </Text>
                  disabled={busy !== null || selected.length === 0}
                  loading={busy === "confirm"}
                  disabled={busy !== null}
        </View>
      ) : null}
    </View>
  );
}
