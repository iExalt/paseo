import { useLayoutEffect, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import { useSessionStore } from "@/stores/session-store";
import { useNotificationReceipt, type NotificationReceipt } from "./preview";
import { recordNotificationOpenStage } from "./trace";

const ignorePreviewLink = () => {};

export function NotificationWorkspaceFallback({
  serverId,
  workspaceId,
  children,
}: {
  serverId: string;
  workspaceId: string;
  children: ReactNode;
}) {
  const receipt = useNotificationReceipt((state) =>
    state.receipt?.serverId === serverId ? state.receipt : null,
  );
  const agentWorkspaceId = useSessionStore((state) => {
    if (!receipt) return null;
    const session = state.sessions[serverId];
    return (
      (session?.agents.get(receipt.agentId) ?? session?.agentDetails.get(receipt.agentId))
        ?.workspaceId ?? null
    );
  });
  if (!receipt || agentWorkspaceId !== workspaceId) return children;
  return (
    <NotificationPreviewFallback serverId={serverId} agentId={receipt.agentId}>
      {children}
    </NotificationPreviewFallback>
  );
}

export function NotificationMessagePreview({ receipt }: { receipt: NotificationReceipt }) {
  const { t } = useTranslation();
  useLayoutEffect(() => {
    recordNotificationOpenStage(receipt.serverId, receipt.agentId, "preview-commit");
    const frame = requestAnimationFrame(() => {
      recordNotificationOpenStage(receipt.serverId, receipt.agentId, "preview-frame");
    });
    return () => cancelAnimationFrame(frame);
  }, [receipt]);
  return (
    <View style={styles.message} testID="notification-message-preview">
      <Text style={styles.label}>{t("nativeNotifications.preview.label")}</Text>
      <AssistantFileLinkResolverProvider client={null}>
        <MarkdownRenderer text={receipt.preview.text} selectable onLinkPress={ignorePreviewLink} />
      </AssistantFileLinkResolverProvider>
      {receipt.preview.truncated ? (
        <Text style={styles.label}>{t("nativeNotifications.preview.truncated")}</Text>
      ) : null}
    </View>
  );
}

/** The agent/workspace may not be cached yet. Show the receipt without inventing either. */
export function NotificationPreviewFallback({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId?: string;
  children: ReactNode;
}) {
  const receipt = useNotificationReceipt((state) =>
    state.receipt?.serverId === serverId && state.receipt.agentId === agentId
      ? state.receipt
      : null,
  );
  if (!receipt) return children;
  return (
    <View style={styles.fallback} testID="notification-preview-fallback">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <NotificationMessagePreview receipt={receipt} />
      </ScrollView>
      <View style={styles.status}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: { gap: theme.spacing[2], paddingVertical: theme.spacing[3] },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  fallback: { flex: 1, backgroundColor: theme.colors.background },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
  },
  status: { height: 160 },
}));
