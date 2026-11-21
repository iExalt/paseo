import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";

const AUTH_POLL_INTERVAL_MS = 2000;

interface CursorSdkAccountProps {
  serverId: string;
  visible: boolean;
}

const statusLabels = {
  api_key: "settings.providers.cursorSdk.apiKey",
  signed_in: "settings.providers.cursorSdk.signedIn",
  signed_out: "settings.providers.cursorSdk.signedOut",
  pending: "settings.providers.cursorSdk.pending",
  unavailable: "settings.providers.cursorSdk.statusFailed",
  checking: "settings.providers.cursorSdk.checking",
} as const;

function useCursorSdkAuth({ serverId, visible }: CursorSdkAccountProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [attempt, setAttempt] = useState<{ id: string; url: string | null } | null>(null);
  const [browserError, setBrowserError] = useState(false);

  const query = useFetchQuery({
    queryKey: ["cursor-sdk-auth", serverId, attempt?.id ?? null],
    enabled: visible && connected && client !== null,
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
    refetchInterval: ({ state }) =>
      visible && (state.data?.status === "pending" || (attempt && !state.data))
        ? AUTH_POLL_INTERVAL_MS
        : false,
    queryFn: () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getCursorSdkAuthStatus(attempt?.id);
    },
  });
  const { data, refetch } = query;

  useEffect(() => {
    if (!data || data.status === "pending") return;
    if (attempt?.url) setAttempt({ id: attempt.id, url: null });
    setBrowserError(false);
  }, [attempt, data]);

  const openBrowser = useCallback(async (url: string) => {
    setBrowserError(false);
    try {
      await openExternalUrl(url);
    } catch {
      setBrowserError(true);
    }
  }, []);

  const start = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.startCursorSdkSignIn();
      if (result.error) throw new Error(result.error);
      if (!result.attemptId || !result.url)
        throw new Error(t("settings.providers.cursorSdk.startFailed"));
      const url = parseSignInUrl(result.url);
      if (!url) throw new Error(t("settings.providers.cursorSdk.startFailed"));
      setAttempt({ id: result.attemptId, url });
      void openBrowser(url);
    },
  });
  const cancel = useMutation({
    mutationFn: async (attemptId: string) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.cancelCursorSdkSignIn(attemptId);
      if (result.error) throw new Error(result.error);
    },
    onSuccess: () => {
      setAttempt(null);
      setBrowserError(false);
      void refetch();
    },
  });
  const status: keyof typeof statusLabels =
    data?.status ?? getUnresolvedStatus(attempt?.id, query.isError);
  const error =
    query.error?.message ?? data?.error ?? start.error?.message ?? cancel.error?.message;
  const errorText =
    error || (browserError ? t("settings.providers.cursorSdk.browserFailed") : null);
  const { mutate: startSignIn, isPending: starting, reset: resetStart } = start;
  const { mutate: cancelSignIn, isPending: canceling } = cancel;
  const handleSignIn = useCallback(() => startSignIn(), [startSignIn]);
  const handleOpenBrowser = useCallback(() => {
    if (attempt?.url) void openBrowser(attempt.url);
  }, [attempt, openBrowser]);
  const handleCancel = useCallback(() => {
    if (attempt) cancelSignIn(attempt.id);
  }, [attempt, cancelSignIn]);
  const handleRetryStatus = useCallback(() => {
    resetStart();
    void refetch();
  }, [refetch, resetStart]);

  return {
    status,
    errorText,
    connected,
    starting,
    canceling,
    canReopen: Boolean(attempt?.url),
    checking: query.isFetching,
    handleSignIn,
    handleOpenBrowser,
    handleCancel,
    handleRetryStatus,
  };
}

function parseSignInUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function getUnresolvedStatus(
  attemptId: string | undefined,
  failed: boolean,
): keyof typeof statusLabels {
  if (attemptId) return "pending";
  return failed ? "unavailable" : "checking";
}

export function CursorSdkAccount(props: CursorSdkAccountProps) {
  const { t } = useTranslation();
  const auth = useCursorSdkAuth(props);

  return (
    <View style={[settingsStyles.card, styles.card]} testID="cursor-sdk-account">
      <Text style={settingsStyles.rowTitle}>{t("settings.providers.cursorSdk.title")}</Text>
      <Text style={styles.description} accessibilityLiveRegion="polite">
        {t(statusLabels[auth.status])}
      </Text>
      {auth.errorText ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {auth.errorText}
        </Text>
      ) : null}
      {auth.status === "pending" && auth.canReopen ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            onPress={auth.handleOpenBrowser}
            leftIcon={ArrowUpRight}
            disabled={auth.canceling}
          >
            {t("settings.providers.cursorSdk.openBrowser")}
          </Button>
          <Button
            variant="ghost"
            onPress={auth.handleCancel}
            disabled={!auth.connected || auth.canceling}
          >
            {t("common.actions.cancel")}
          </Button>
        </View>
      ) : null}
      {auth.status === "signed_out" ? (
        <View style={styles.actions}>
          <Button
            onPress={auth.handleSignIn}
            disabled={!auth.connected || auth.starting}
            loading={auth.starting}
          >
            {t("settings.providers.cursorSdk.signIn")}
          </Button>
        </View>
      ) : null}
      {auth.status === "unavailable" ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            onPress={auth.handleRetryStatus}
            disabled={!auth.connected || auth.checking}
          >
            {t("settings.providers.models.retry")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
