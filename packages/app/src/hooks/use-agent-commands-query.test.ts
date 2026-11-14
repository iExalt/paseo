/** @vitest-environment jsdom */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentCommandsClient,
  type DraftCommandConfig,
  fetchAgentCommands,
  useAgentCommandsQuery,
} from "./use-agent-commands-query";

type ListCommands = AgentCommandsClient["listCommands"];
type ListCommandsResult = Awaited<ReturnType<ListCommands>>;

interface ListCommandsCall {
  agentId: string;
  draftConfig: DraftCommandConfig | undefined;
}

interface FakeAgentCommandsClient extends AgentCommandsClient {
  calls: ListCommandsCall[];
}

function createClient(response: ListCommandsResult): FakeAgentCommandsClient {
  const calls: ListCommandsCall[] = [];
  return {
    calls,
    listCommands: (async (options: Parameters<ListCommands>[0]) => {
      calls.push({ agentId: options.agentId, draftConfig: options.draftConfig });
      return response;
    }) as ListCommands,
  };
}

function commandsPayload(commands: ListCommandsResult["commands"]): ListCommandsResult {
  return {
    requestId: "req_commands",
    agentId: "",
    error: null,
    commands,
  };
}

describe("fetchAgentCommands", () => {
  it("loads commands for a draft composer without an agent id", async () => {
    const client = createClient(
      commandsPayload([{ name: "compact", description: "Compact context", argumentHint: "" }]),
    );

    const draftConfig: DraftCommandConfig = {
      provider: "opencode",
      cwd: "/repo",
      modeId: "build",
    };

    const commands = await fetchAgentCommands({ client, agentId: "", draftConfig });

    expect(commands).toEqual([
      { name: "compact", description: "Compact context", argumentHint: "" },
    ]);
    expect(client.calls).toEqual([{ agentId: "", draftConfig }]);
  });

  it("passes the agent id when fetching commands for a running agent", async () => {
    const client = createClient(commandsPayload([]));

    await fetchAgentCommands({ client, agentId: "agent-1" });

    expect(client.calls).toEqual([{ agentId: "agent-1", draftConfig: undefined }]);
  });
});

const live = vi.hoisted(() => ({
  connected: true,
  listCommands: vi.fn(),
  on: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => live,
  useHostRuntimeIsConnected: () => live.connected,
}));
vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => true }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  live.listCommands.mockReset();
  live.on.mockReset();
  live.connected = true;
});

it("replaces a stale first load when skills change while the request is in flight", async () => {
  let finishOld!: (response: ListCommandsResult) => void;
  const old = new Promise<ListCommandsResult>((resolve) => {
    finishOld = resolve;
  });
  const fresh = [{ name: "new_skill", description: "new", argumentHint: "" }];
  live.listCommands.mockReturnValueOnce(old).mockResolvedValue(commandsPayload(fresh));
  let changed!: (message: { payload: { agentId: string; cwd: string; provider: string } }) => void;
  const unsubscribe = vi.fn();
  live.on.mockImplementation((_type, callback) => {
    changed = callback;
    return unsubscribe;
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, unmount } = renderHook(
    () => useAgentCommandsQuery({ serverId: "host", agentId: "agent" }),
    {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  try {
    await waitFor(() => expect(live.listCommands).toHaveBeenCalledOnce());
    act(() => changed({ payload: { agentId: "other", cwd: "/repo", provider: "codex" } }));
    expect(live.listCommands).toHaveBeenCalledOnce();
    act(() => changed({ payload: { agentId: "agent", cwd: "/repo", provider: "codex" } }));
    await waitFor(() => expect(result.current.commands).toEqual(fresh));
    await act(async () => {
      finishOld(commandsPayload([{ name: "removed", description: "old", argumentHint: "" }]));
      await old;
    });
    expect(result.current.commands).toEqual(fresh);
  } finally {
    unmount();
    queryClient.clear();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("refreshes a draft's cached skills after reconnecting", async () => {
  live.listCommands.mockResolvedValue(
    commandsPayload([{ name: "before", description: "", argumentHint: "" }]),
  );
  live.on.mockReturnValue(() => {});
  const queryClient = new QueryClient();
  const config = {
    serverId: "host",
    agentId: "",
    draftConfig: { provider: "codex", cwd: "/repo" },
  };
  const { result, rerender, unmount } = renderHook(() => useAgentCommandsQuery(config), {
    wrapper: ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children),
  });
  try {
    await waitFor(() => expect(result.current.commands[0]?.name).toBe("before"));
    live.connected = false;
    rerender();
    live.listCommands.mockResolvedValue(commandsPayload([]));
    live.connected = true;
    rerender();
    await waitFor(() => expect(result.current.commands).toEqual([]));
  } finally {
    unmount();
    queryClient.clear();
  }
});
