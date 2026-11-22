import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
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
  expired: "settings.providers.cursorSdk.expired",
  pending: "settings.providers.cursorSdk.pending",
  unavailable: "settings.providers.cursorSdk.statusFailed",
  checking: "settings.providers.cursorSdk.checking",
} as const;

type AuthStatus = Awaited<ReturnType<DaemonClient["getCursorSdkAuthStatus"]>>;

function useAccountStatus(
  serverId: string,
  client: DaemonClient | null,
  enabled: boolean,
  recovery: boolean,
  attemptId?: string,
) {
  const { t } = useTranslation();
  return useFetchQuery({
    queryKey: ["cursor-sdk-auth", serverId, attemptId ?? null],
    enabled: enabled,
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: ({ state }) =>
      enabled && (recovery || state.data?.status === "pending" || (attemptId && !state.data))
        ? AUTH_POLL_INTERVAL_MS
        : false,
    queryFn: () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getCursorSdkAuthStatus(attemptId);
    },
  });
}

function getViewStatus(
  online: boolean,
  data: AuthStatus | undefined,
  hasLegacyAttempt: boolean,
): keyof typeof statusLabels {
  if (!online) return "unavailable";
  if (data?.expired) return "expired";
  if (data) return data.status;
  return hasLegacyAttempt ? "pending" : "checking";
}

type AccountCommand = "start" | "sign_out" | { cancel: string };

function useCursorSdkAuth({ serverId, visible }: CursorSdkAccountProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const recovery = useHostFeature(serverId, "cursorSdkAuthRecovery");
  // COMPAT(cursorSdkAuthRecovery): added in v0.32.x, remove local attempt state once the daemon floor supports recovery.
  const [legacyAttempt, setLegacyAttempt] = useState<{ id: string; url: string } | null>(null);
  const [browserError, setBrowserError] = useState(false);
  const interactive = useRef(false);
  useEffect(() => {
    interactive.current = visible && connected;
    return () => {
      interactive.current = false;
    };
  }, [visible, connected]);

  const query = useAccountStatus(
    serverId,
    client,
    visible && connected,
    recovery,
    legacyAttempt?.id,
  );
  const { data, refetch } = query;

  const openBrowser = useCallback(async (url: string) => {
    if (!interactive.current) return;
    setBrowserError(false);
    try {
      await openExternalUrl(url);
    } catch {
      setBrowserError(true);
    }
  }, []);

  const mutation = useMutation({
    mutationFn: async (command: AccountCommand) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      if (command === "start") {
        const result = await client.startCursorSdkSignIn();
        if (result.error) throw new Error(result.error);
        const url = result.url && parseSignInUrl(result.url);
        if (!result.attemptId || !url)
          throw new Error(t("settings.providers.cursorSdk.startFailed"));
        if (!recovery) setLegacyAttempt({ id: result.attemptId, url });
        void openBrowser(url);
        return;
      }

      const result =
        command === "sign_out"
          ? await client.signOutCursorSdk()
          : await client.cancelCursorSdkSignIn(command.cancel);
      if (result.error) throw new Error(result.error);
      setLegacyAttempt(null);
      setBrowserError(false);
    },
    onSettled: () => refetch(),
  });

  const { mutate, isPending, variables, reset } = mutation;
  const activeCommand = isPending ? variables : null;
  const status = getViewStatus(connected && !query.isError, data, Boolean(legacyAttempt));
  const pendingAttempt = recovery ? data?.attempt : legacyAttempt;
  const attempt = status === "pending" ? pendingAttempt : undefined;
  const error = query.error?.message ?? data?.error ?? mutation.error?.message;
  const pendingBrowserError =
    browserError && status === "pending" ? t("settings.providers.cursorSdk.browserFailed") : null;
  const errorText = connected
    ? error || pendingBrowserError
    : t("workspace.terminal.hostDisconnected");

  const handleSignIn = useCallback(() => mutate("start"), [mutate]);
  const handleOpenBrowser = useCallback(() => {
    const url = attempt?.url && parseSignInUrl(attempt.url);
    if (url) void openBrowser(url);
  }, [attempt, openBrowser]);
  const handleCancel = useCallback(() => {
    if (attempt) mutate({ cancel: attempt.id });
  }, [attempt, mutate]);
  const handleSignOut = useCallback(() => mutate("sign_out"), [mutate]);
  const handleRetryStatus = useCallback(() => {
    reset();
    void refetch();
  }, [refetch, reset]);

  return {
    status,
    errorText,
    connected,
    busy: isPending,
    starting: activeCommand === "start",
    signingOut: activeCommand === "sign_out",
    canCancel: Boolean(attempt),
    canReopen: Boolean(attempt?.url),
    canSignOut: recovery && (status === "signed_in" || status === "expired"),
    checking: query.isFetching,
    handleSignIn,
    handleOpenBrowser,
    handleCancel,
    handleSignOut,
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

export function CursorSdkAccount(props: CursorSdkAccountProps) {
  return <CursorSdkAccountView key={props.serverId} {...props} />;
}

function CursorSdkAccountView(props: CursorSdkAccountProps) {
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
      {auth.canCancel ? (
        <View style={styles.actions}>
          {auth.canReopen ? (
            <Button
              variant="outline"
              onPress={auth.handleOpenBrowser}
              leftIcon={ArrowUpRight}
              disabled={!auth.connected || auth.busy}
            >
              {t("settings.providers.cursorSdk.openBrowser")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onPress={auth.handleCancel}
            disabled={!auth.connected || auth.busy}
          >
            {t("common.actions.cancel")}
          </Button>
        </View>
      ) : null}
      {auth.status === "signed_out" || auth.status === "expired" || auth.canSignOut ? (
        <View style={styles.actions}>
          {auth.status !== "signed_in" ? (
            <Button
              onPress={auth.handleSignIn}
              disabled={!auth.connected || auth.busy}
              loading={auth.starting}
            >
              {t("settings.providers.cursorSdk.signIn")}
            </Button>
          ) : null}
          {auth.canSignOut ? (
            <Button
              variant="outline"
              onPress={auth.handleSignOut}
              disabled={!auth.connected || auth.busy}
              loading={auth.signingOut}
            >
              {t("settings.providers.cursorSdk.signOut")}
            </Button>
          ) : null}
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
