import { supportsSpendSummary } from "@getpaseo/client/internal/daemon-client";
import type { SpendSummary } from "@getpaseo/protocol/messages";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { usageCopy } from "./copy";

// Spend grows with every finished turn, and the daemon answers from memory.
const SPEND_STALE_TIME_MS = 10_000;

/** What a host's spend section shows. `unavailable` is a host state, not a failed request. */
export type SpendView =
  | { kind: "unavailable"; message: string }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; summary: SpendSummary };

export function resolveSpendView(input: {
  hostLabel: string;
  isConnected: boolean;
  isSupported: boolean;
  query: { data: SpendSummary | undefined; error: unknown };
}): SpendView {
  const { hostLabel, isConnected, isSupported, query } = input;
  if (!isConnected) {
    return { kind: "unavailable", message: usageCopy.spendHostUnavailable(hostLabel) };
  }
  if (!isSupported)
    return { kind: "unavailable", message: usageCopy.spendUpgradeRequired(hostLabel) };
  if (query.data) return { kind: "ready", summary: query.data };
  if (query.error) {
    return {
      kind: "error",
      message: query.error instanceof Error ? query.error.message : String(query.error),
    };
  }
  return { kind: "loading" };
}

/** Every time zone's spend query for a host, so one refresh reaches whichever is shown. */
function spendQueryKeyPrefix(serverId: string) {
  return ["usage", serverId, "spend"] as const;
}

/** The device's IANA time zone, so "today" on the host means today where the user is. */
function deviceTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

/** What agents on a host spent, by provider, as reported by each provider. */
export function useHostSpend(serverId: string): SpendView {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) =>
    supportsSpendSummary(state.sessions[serverId]?.serverInfo?.features),
  );
  const timeZone = deviceTimeZone();
  const query = useFetchQuery({
    queryKey: [...spendQueryKeyPrefix(serverId), timeZone ?? "UTC"],
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error(usageCopy.clientUnavailable);
      return (await client.getSpendSummary({ timeZone })).summary;
    },
    enabled: isConnected && isSupported,
    dataShape: "value",
    staleTimeMs: SPEND_STALE_TIME_MS,
  });
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? serverId;
  return resolveSpendView({
    hostLabel,
    isConnected,
    isSupported,
    query: { data: query.data, error: query.error },
  });
}

/** Refetches a host's spend now instead of when it next goes stale. */
export function useRefreshHostSpend(serverId: string): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: spendQueryKeyPrefix(serverId) });
  }, [queryClient, serverId]);
}
