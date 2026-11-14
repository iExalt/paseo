import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { Command } from "commander";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { acknowledgeAgents, addAckOptions } from "./ack.js";
import { agentQuerySchema } from "./query.js";
import { inspectAgent } from "./inspect.js";
import { buildAgentLsFetchOptions, listAgents } from "./ls.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createPagingClient(usage?: AgentSnapshotPayload["lastUsage"], attention = false) {
  const daemonAgents: AgentSnapshotPayload[] = [3, 2, 1].map((n) => ({
    id: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`,
    provider: "codex",
    title: `agent ${n}`,
    status: "closed",
    archivedAt: null,
    cwd: "/tmp/project",
    createdAt: `2026-10-0${n}T00:00:00.000Z`,
    updatedAt: `2026-10-0${n}T00:00:00.000Z`,
    labels: attention ? { [PARENT_AGENT_ID_LABEL]: "parent-id", team: "cli" } : {},
    requiresAttention: attention && n === 2,
    attentionReason: attention && n === 2 ? "finished" : null,
    attentionTimestamp: attention && n === 2 ? "2026-10-02T00:00:00.000Z" : null,
    lastError: attention && n === 2 ? "example failure" : null,
    lastUsage: usage,
    model: null,
    lastUserMessageAt: null,
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
  }));

  // The fake daemon pages two agents at a time, newest first by the requested key
  // (updated_at by default), and agent 1 is updated right after the first page is served.
  const fetchAgents = async (options?: {
    sort?: { key: string }[];
    page?: { cursor?: string };
  }) => {
    const key: "createdAt" | "updatedAt" =
      options?.sort?.[0]?.key === "created_at" ? "createdAt" : "updatedAt";
    const cursor = options?.page?.cursor;
    const ordered = daemonAgents
      .filter((agent) => cursor === undefined || agent[key] < cursor)
      .sort((left, right) => right[key].localeCompare(left[key]));
    const page = ordered.slice(0, 2);
    const hasMore = ordered.length > 2;
    if (cursor === undefined) {
      daemonAgents[2]!.updatedAt = "2026-10-09T00:00:00.000Z";
    }
    return {
      entries: page.map((agent) => ({ agent })),
      pageInfo: { nextCursor: hasMore ? page[page.length - 1]![key] : null },
    };
  };
  return {
    fetchAgents,
    fetchAgent: async () => ({ agent: daemonAgents[0]! }),
    close: async () => {},
  };
}

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("asks the daemon for internal agents only with --internal", () => {
    expect(buildAgentLsFetchOptions({ background: true, global: true })).toEqual({
      filter: { includeBackground: true },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("includes archived and background agents with -a", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

describe("runLsCommand", () => {
  it("lists agents on every page, including one updated during the listing", async () => {
    const result = await listAgents({ daemonTarget, all: true, global: true }, async () =>
      createPagingClient(),
    );

    expect(result.data.map((item) => item.name)).toEqual(["agent 3", "agent 2", "agent 1"]);
  });
});

describe("agent usage output", () => {
  it.each([
    { usage: undefined, percent: null, cost: null, used: null, max: null },
    {
      usage: {
        inputTokens: 0,
        totalCostUsd: 0,
        contextWindowUsedTokens: 0,
        contextWindowMaxTokens: 100,
      },
      percent: 0,
      cost: 0,
      used: 0,
      max: 100,
    },
    {
      usage: { inputTokens: 123, contextWindowUsedTokens: 25, contextWindowMaxTokens: 200 },
      percent: 13,
      cost: null,
      used: 25,
      max: 200,
    },
    {
      usage: { contextWindowUsedTokens: 25, contextWindowMaxTokens: 0 },
      percent: null,
      cost: null,
      used: 25,
      max: 0,
    },
    { usage: { contextWindowUsedTokens: 25 }, percent: null, cost: null, used: 25, max: null },
    {
      usage: { contextWindowUsedTokens: 250, contextWindowMaxTokens: 200 },
      percent: 100,
      cost: null,
      used: 250,
      max: 200,
    },
  ])(
    "preserves reported usage and computes context: $usage",
    async ({ usage, percent, cost, used, max }) => {
      const client = createPagingClient(usage);
      const listed = await listAgents({ daemonTarget, all: true }, async () => client);
      expect(listed.data[0]!.lastUsage).toEqual(usage ?? null);
      expect(listed.data[0]!.contextWindowPercent).toBe(percent);
      const inspected = await inspectAgent("3333333", { daemonTarget }, async () => client);
      const serialized = inspected.schema.serialize!(inspected.data[0]!);
      if (!usage) {
        expect(serialized).toMatchObject({ LastUsage: null });
      } else {
        expect(serialized).toMatchObject({
          LastUsage: {
            InputTokens: usage.inputTokens ?? null,
            OutputTokens: null,
            CachedTokens: null,
            CostUsd: cost,
            ContextWindowUsedTokens: used,
            ContextWindowMaxTokens: max,
            ContextWindowPercent: percent,
          },
        });
        expect(inspected.data.find((row) => row.key === "LastUsage")?.value).toContain(
          cost === null ? "CostUsd: null" : "CostUsd: $0.00",
        );
      }
    },
  );
});

describe("agent attention", () => {
  it("requests attention filtering without changing scope", () => {
    expect(buildAgentLsFetchOptions({ attention: true })).toEqual({
      scope: "active",
      filter: { requiresAttention: true },
    });
  });

  it("filters attention and parent after paging, exposes metadata and inspect rows", async () => {
    const client = createPagingClient(undefined, true);
    const connect = async () => ({
      ...client,
      fetchAgent: async () => ({
        agent: { ...(await client.fetchAgent()).agent, id: "parent-id" },
      }),
    });
    const listed = await listAgents(
      { daemonTarget, all: true, attention: true, parent: "parent" },
      connect,
    );
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      name: "agent 2",
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: "2026-10-02T00:00:00.000Z",
      labels: { team: "cli" },
      lastError: "example failure",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(
      (await listAgents({ daemonTarget, all: true, parent: "other" }, async () => client)).data,
    ).toEqual([]);
    const result = await inspectAgent("id", { daemonTarget }, async () => ({
      ...client,
      fetchAgent: async () => ({
        agent: {
          ...(await client.fetchAgent()).agent,
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "time",
        },
      }),
    }));
    expect(result.schema.serialize!(result.data[0]!)).toMatchObject({
      RequiresAttention: true,
      AttentionReason: "finished",
      AttentionTimestamp: "time",
    });
    expect(result.data).toContainEqual({ key: "AttentionReason", value: "finished" });
    expect(agentQuerySchema.columns.some((column) => column.header === "ATTENTION")).toBe(true);
  });

  it("resolves and deduplicates ack targets before issuing one request", async () => {
    const calls: string[][] = [];
    let closed = false;
    const result = await acknowledgeAgents(
      ["prefix", "session", "prefix"],
      { daemonTarget },
      async () => ({
        fetchAgent: async ({ agentId }) => ({
          agent: { id: agentId === "session" ? "second-id" : "first-id" },
        }),
        clearAgentAttention: async (ids) => {
          calls.push(typeof ids === "string" ? [ids] : ids);
        },
        close: async () => {
          closed = true;
        },
      }),
    );
    expect(calls).toEqual([["first-id", "second-id"]]);
    expect(result.data).toEqual({ agentIds: ["first-id", "second-id"], acknowledgedCount: 2 });
    expect(closed).toBe(true);
    expect(addAckOptions(new Command("ack")).registeredArguments[0]!.variadic).toBe(true);
  });

  it.each(["missing", "ambiguous", "rpc"])(
    "fails ack and closes the client on %s errors",
    async (failure) => {
      let clears = 0;
      let closed = false;
      await expect(
        acknowledgeAgents(["valid", failure], { daemonTarget }, async () => ({
          fetchAgent: async ({ agentId }) => {
            if (agentId === "missing") return null;
            if (agentId === "ambiguous") throw new Error("ambiguous");
            return { agent: { id: agentId } };
          },
          clearAgentAttention: async () => {
            clears++;
            throw new Error("rpc failed");
          },
          close: async () => {
            closed = true;
          },
        })),
      ).rejects.toBeDefined();
      expect(clears).toBe(failure === "rpc" ? 1 : 0);
      expect(closed).toBe(true);
    },
  );
});

describe("parent lookup failures", () => {
  it.each([
    null,
    { code: "AMBIGUOUS_AGENT", message: "Choose an exact ID", details: "two matches" },
    new Error("offline"),
  ])("preserves diagnostics and closes the client: %s", async (failure) => {
    let closed = false;
    const client = {
      ...createPagingClient(),
      fetchAgent: async () => {
        if (failure) throw failure;
        return null;
      },
      close: async () => {
        closed = true;
      },
    };
    const expected =
      failure instanceof Error
        ? { code: "LIST_AGENTS_FAILED", message: "Failed to list agents: offline" }
        : (failure ?? { code: "AGENT_NOT_FOUND", message: "No agent found matching: missing" });
    await expect(
      listAgents({ daemonTarget, parent: "missing" }, async () => client),
    ).rejects.toMatchObject(expected);
    expect(closed).toBe(true);
  });
});
