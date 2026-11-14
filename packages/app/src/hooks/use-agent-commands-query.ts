import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  agentCommandsQueryKey,
  normalizeAgentCommandsCwd,
  type AgentCommandsDraftConfig,
} from "@/hooks/agent-commands-query";

const DRAFT_COMMANDS_STALE_TIME = Number.POSITIVE_INFINITY;
const SESSION_COMMANDS_STALE_TIME = 60_000;

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: string;
}

export type DraftCommandConfig = AgentCommandsDraftConfig;

/** What a draft composer can list commands for, before an agent exists. */
export type DraftCommandTarget =
  | { status: "ready"; config: DraftCommandConfig }
  | { status: "needs-project" }
  | { status: "needs-provider" };

interface ListAgentCommandsOptions {
  agentId: string;
  draftConfig?: DraftCommandConfig;
}

export interface AgentCommandsClient {
  listCommands(options: ListAgentCommandsOptions): ReturnType<DaemonClient["listCommands"]>;
}

export async function fetchAgentCommands(input: {
  client: AgentCommandsClient;
  agentId: string;
  draftConfig?: DraftCommandConfig;
}): Promise<AgentSlashCommand[]> {
  const response = await input.client.listCommands({
    agentId: input.agentId,
    draftConfig: input.draftConfig,
  });
  return response.commands as AgentSlashCommand[];
}

interface UseAgentCommandsQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
  draftConfig?: DraftCommandConfig;
}

export function useAgentCommandsQuery({
  serverId,
  agentId,
  enabled = true,
  draftConfig,
}: UseAgentCommandsQueryOptions) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const previouslyConnected = useRef(isConnected);

  const query = useQuery({
    queryKey: agentCommandsQueryKey({ serverId, agentId, draftConfig }),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return fetchAgentCommands({ client, agentId, draftConfig });
    },
    enabled: queryEnabled && !!client && isConnected && (!!agentId || !!draftConfig),
    staleTime: draftConfig ? DRAFT_COMMANDS_STALE_TIME : SESSION_COMMANDS_STALE_TIME,
    refetchOnMount: "always",
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  useEffect(() => {
    if (!client) {
      previouslyConnected.current = false;
      return;
    }
    const queryKey = agentCommandsQueryKey({ serverId, agentId, draftConfig });
    const refresh = async () => {
      // Cancel even a first load: invalidating alone can reuse its stale in-flight result.
      await queryClient.cancelQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey });
    };
    const unsubscribe = client.on("agent.commands.changed", ({ payload }) => {
      const matches = draftConfig
        ? payload.provider === draftConfig.provider &&
          normalizeAgentCommandsCwd(payload.cwd) === normalizeAgentCommandsCwd(draftConfig.cwd)
        : payload.agentId === agentId;
      if (matches) void refresh();
    });
    if (isConnected && !previouslyConnected.current) void refresh();
    previouslyConnected.current = isConnected;
    return unsubscribe;
  }, [client, queryClient, serverId, agentId, draftConfig, isConnected]);

  // isPending is true when the query has never run yet (no cached data and not fetching)
  // isLoading is true when fetching and no data yet
  const isLoading = query.isPending || query.isLoading;

  return {
    commands: query.data ?? [],
    isLoading,
    isError: query.isError,
    error: query.error,
  };
}
