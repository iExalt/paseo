import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAgentRunDocument } from "@cursor/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { SpendLedger } from "../spend-ledger.js";
import {
  buildCursorUsageQueryPlan,
  CursorDashboardUsageClient,
  CursorSessionCost,
  cursorUsageEventCents,
  type CursorDashboardUsageFetcher,
  type MatchedCursorUsageEvent,
} from "./cursor-sdk-cost.js";

const BASE_TIME = Date.parse("2026-11-23T12:00:00Z");

function makeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeRun(
  overrides: Partial<LocalAgentRunDocument> & { runId: string; agentId: string },
): LocalAgentRunDocument {
  return {
    turnNumber: 1,
    status: "finished",
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 5_000,
    startedAt: BASE_TIME,
    endedAt: BASE_TIME + 5_000,
    startCheckpointRef: null,
    latestCheckpointRef: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("cursorUsageEventCents", () => {
  test("prefers positive chargedCents and falls back to tokenUsage.totalCents", () => {
    expect(cursorUsageEventCents({ chargedCents: 54.84, tokenUsage: { totalCents: 55.45 } })).toBe(
      54.84,
    );
    expect(cursorUsageEventCents({ chargedCents: 0, tokenUsage: { totalCents: 12.5 } })).toBe(12.5);
    expect(cursorUsageEventCents({ tokenUsage: { totalCents: 8.2 } })).toBe(8.2);
    expect(
      cursorUsageEventCents({ chargedCents: 0, tokenUsage: { totalCents: 0 } }),
    ).toBeUndefined();
    expect(cursorUsageEventCents({})).toBeUndefined();
  });
});

describe("buildCursorUsageQueryPlan", () => {
  test("coalesces nearby runs, separates multi-day gaps, and deduplicates copied rewind runs", () => {
    const day1 = BASE_TIME;
    const day3 = BASE_TIME + 48 * 60 * 60 * 1_000;
    const plan = buildCursorUsageQueryPlan(
      [
        makeRun({
          agentId: "agent-parent",
          runId: "run-unused-reservation",
          turnNumber: 1,
          status: "cancelled",
          createdAt: day1 - 24 * 60 * 60 * 1_000,
          startedAt: null,
          endedAt: day3,
          usage: null,
        }),
        makeRun({
          agentId: "agent-parent",
          runId: "run-1",
          requestId: "req-1",
          turnNumber: 1,
          startedAt: day1,
          endedAt: day1 + 10_000,
          usage: {
            inputTokens: 1_000,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 1_200,
          },
        }),
        makeRun({
          agentId: "agent-fork",
          runId: "run-1-copy",
          requestId: "req-1",
          turnNumber: 1,
          startedAt: day1,
          endedAt: day1 + 10_000,
          usage: {
            inputTokens: 1_000,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 1_200,
          },
        }),
        makeRun({
          agentId: "agent-parent",
          runId: "run-2-discarded",
          requestId: "req-2",
          turnNumber: 2,
          startedAt: day1 + 180_000,
          endedAt: day1 + 200_000,
          usage: {
            inputTokens: 2_000,
            outputTokens: 300,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2_300,
          },
        }),
        makeRun({
          agentId: "agent-fork",
          runId: "run-3-fork",
          requestId: "req-3",
          turnNumber: 2,
          startedAt: day3,
          endedAt: day3 + 15_000,
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 600,
          },
        }),
      ],
      day3 + 60_000,
    );

    expect(plan.startedRunCount).toBe(3);
    expect(plan.reportedTokens).toBe(4_100);
    expect(plan.windows).toHaveLength(2);
    expect(plan.windows[0]).toMatchObject({
      startMs: day1 - 60_000,
      endMs: day1 + 200_000 + 60_000,
      allTerminal: true,
    });
    expect(plan.windows[1]).toMatchObject({
      startMs: day3 - 60_000,
      endMs: day3 + 15_000 + 60_000,
      allTerminal: true,
    });
  });
});

describe("CursorDashboardUsageClient", () => {
  test("caches exchanged JWT until expiry skew, retries once on 401, and filters by conversationIds", async () => {
    let nowMs = BASE_TIME;
    let exchangeCount = 0;
    let usageCallCount = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/auth/exchange_user_api_key")) {
        exchangeCount += 1;
        const token = makeJwt(Math.floor((nowMs + 300_000) / 1_000));
        return new Response(JSON.stringify({ accessToken: token }), { status: 200 });
      }
      if (target.endsWith("/aiserver.v1.DashboardService/GetFilteredUsageEvents")) {
        usageCallCount += 1;
        if (usageCallCount === 2) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          JSON.stringify({
            totalUsageEventsCount: 2,
            usageEventsDisplay: [
              {
                usageEventId: "ev-ours",
                timestamp: String(BASE_TIME + 1_000),
                conversationId: "agent-ours",
                chargedCents: 54.84,
                tokenUsage: {
                  inputTokens: 1_000,
                  outputTokens: 200,
                  cacheReadTokens: 3_000,
                  totalCents: 55.45,
                },
              },
              {
                usageEventId: "ev-other",
                timestamp: String(BASE_TIME + 2_000),
                conversationId: "agent-other",
                chargedCents: 999,
                tokenUsage: { inputTokens: 9_000, outputTokens: 1_000 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL ${target} (${String(init?.method)})`);
    });

    const client = new CursorDashboardUsageClient(
      fetchMock as unknown as typeof fetch,
      () => "https://api2.cursor.sh",
      () => nowMs,
    );

    const first = await client.fetchWindow({
      apiKey: "key-1",
      startMs: BASE_TIME,
      endMs: BASE_TIME + 10_000,
      conversationIds: new Set(["agent-ours"]),
    });
    expect(exchangeCount).toBe(1);
    expect(first).toEqual({
      complete: true,
      events: [
        {
          eventId: "ev-ours",
          conversationId: "agent-ours",
          timestampMs: BASE_TIME + 1_000,
          cents: 54.84,
          accountedTokens: 4_200,
        },
      ],
    });

    const second = await client.fetchWindow({
      apiKey: "key-1",
      startMs: BASE_TIME,
      endMs: BASE_TIME + 10_000,
      conversationIds: new Set(["agent-ours"]),
    });
    expect(exchangeCount).toBe(2);
    expect(second.complete).toBe(true);
    expect(second.events[0]?.cents).toBe(54.84);

    nowMs += 250_000;
    await client.fetchWindow({
      apiKey: "key-1",
      startMs: BASE_TIME,
      endMs: BASE_TIME + 10_000,
      conversationIds: new Set(["agent-ours"]),
    });
    expect(exchangeCount).toBe(3);
  });

  test("marks window incomplete when pagination hits the page cap", async () => {
    const pageItems = Array.from({ length: 100 }, (_, i) => ({
      usageEventId: `ev-${i}`,
      timestamp: String(BASE_TIME + i),
      conversationId: "agent-other",
      chargedCents: 1,
    }));
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/auth/exchange_user_api_key")) {
        return new Response(JSON.stringify({ accessToken: "tok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ totalUsageEventsCount: 2_000, usageEventsDisplay: pageItems }),
        { status: 200 },
      );
    });
    const client = new CursorDashboardUsageClient(
      fetchMock as unknown as typeof fetch,
      () => "https://api2.cursor.sh",
    );
    const result = await client.fetchWindow({
      apiKey: "key-cap",
      startMs: BASE_TIME,
      endMs: BASE_TIME + 10_000,
      conversationIds: new Set(["agent-ours"]),
    });
    expect(result.complete).toBe(false);
  });
});

describe("CursorSessionCost", () => {
  test("confirms in-place subagent growth and upgrades SpendLedger turns without double counting", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "cursor-cost-ledger-"));
    tempDirs.push(dir);
    const ledger = new SpendLedger({
      paseoHome: dir,
      logger: createTestLogger(),
      now: () => new Date(BASE_TIME + 60_000),
    });
    await ledger.initialize();

    await ledger.record({
      agentId: "paseo-agent-1",
      provider: "cursor-sdk",
      createdAt: new Date(BASE_TIME),
      turnId: "turn-1",
      usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
    });
    await ledger.record({
      agentId: "paseo-agent-1",
      provider: "cursor-sdk",
      createdAt: new Date(BASE_TIME),
      turnId: "turn-2",
      usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1_000 },
    });
    expect((await ledger.summarize("UTC")).totals?.unknownCostRuns?.allTime).toBe(2);

    const runs: LocalAgentRunDocument[] = [
      makeRun({
        agentId: "agent-root",
        runId: "run-1",
        requestId: "req-1",
        turnNumber: 1,
        usage: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_200,
        },
      }),
      makeRun({
        agentId: "agent-root",
        runId: "run-2",
        requestId: "req-2",
        turnNumber: 2,
        startedAt: BASE_TIME + 20_000,
        endedAt: BASE_TIME + 30_000,
        usage: {
          inputTokens: 800,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_000,
        },
      }),
    ];

    const snapshots: MatchedCursorUsageEvent[][] = [
      [{ eventId: "ev-1", conversationId: "agent-root", cents: 30, accountedTokens: 1_000 }],
      [
        { eventId: "ev-1", conversationId: "agent-root", cents: 50, accountedTokens: 2_000 },
        { eventId: "ev-2", conversationId: "agent-root", cents: 50, accountedTokens: 3_000 },
      ],
      [
        { eventId: "ev-1", conversationId: "agent-root", cents: 50, accountedTokens: 2_000 },
        { eventId: "ev-2", conversationId: "agent-root", cents: 97, accountedTokens: 6_000 },
      ],
      [
        { eventId: "ev-1", conversationId: "agent-root", cents: 50, accountedTokens: 2_000 },
        { eventId: "ev-2", conversationId: "agent-root", cents: 97, accountedTokens: 6_000 },
      ],
    ];
    let pollIndex = 0;
    const published: Array<{ usd: number; turnId?: string }> = [];
    const fetcher: CursorDashboardUsageFetcher = {
      fetchWindow: vi.fn(async () => ({
        complete: true,
        events: snapshots[Math.min(pollIndex++, snapshots.length - 1)]!,
      })),
    };

    const cost = new CursorSessionCost({
      resumed: false,
      readLineage: async () => ["agent-root"],
      readRuns: async () => runs,
      readApiKey: async () => "api-key",
      fetcher,
      publish: (usd, turnId) => {
        published.push({ usd, turnId });
        void ledger.record({
          agentId: "paseo-agent-1",
          provider: "cursor-sdk",
          createdAt: new Date(BASE_TIME),
          totalUsd: usd,
          turnId,
        });
      },
      retryDelaysMs: [100, 200, 400],
      confirmDelayMs: 250,
      now: () => BASE_TIME + 40_000,
    });

    cost.refresh("turn-1");
    cost.refresh("turn-2");
    await vi.runAllTimersAsync();
    cost.dispose();

    expect(published).toEqual([
      { usd: 0.3, turnId: undefined },
      { usd: 1.0, turnId: undefined },
      { usd: 1.47, turnId: undefined },
      { usd: 1.47, turnId: "turn-1" },
      { usd: 1.47, turnId: "turn-2" },
    ]);

    const summary = await ledger.summarize("UTC");
    expect(summary.totals?.allTimeUsd).toBeCloseTo(1.47, 6);
    expect(summary.totals?.unknownCostRuns?.allTime).toBe(0);
  });

  test("gates resumed publication on cluster completeness and preserves lifetime cost across rewind lineage", async () => {
    vi.useFakeTimers();
    const day1 = BASE_TIME;
    const day3 = BASE_TIME + 48 * 60 * 60 * 1_000;
    let lineage = ["agent-parent"];
    const runsByAgent: Record<string, LocalAgentRunDocument[]> = {
      "agent-parent": [
        makeRun({
          agentId: "agent-parent",
          runId: "r1",
          requestId: "req-1",
          turnNumber: 1,
          startedAt: day1,
          endedAt: day1 + 10_000,
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 600,
          },
        }),
        makeRun({
          agentId: "agent-parent",
          runId: "r2",
          requestId: "req-2",
          turnNumber: 2,
          startedAt: day3,
          endedAt: day3 + 10_000,
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 600,
          },
        }),
      ],
      "agent-fork": [
        makeRun({
          agentId: "agent-fork",
          runId: "r1-copy",
          requestId: "req-1",
          turnNumber: 1,
          startedAt: day1,
          endedAt: day1 + 10_000,
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 600,
          },
        }),
        makeRun({
          agentId: "agent-fork",
          runId: "r3-fork",
          requestId: "req-3",
          turnNumber: 2,
          startedAt: day3 + 60_000,
          endedAt: day3 + 70_000,
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 600,
          },
        }),
      ],
    };

    let failDay1Once = true;
    const published: Array<{ usd: number; turnId?: string }> = [];
    const fetcher: CursorDashboardUsageFetcher = {
      fetchWindow: vi.fn(async ({ startMs, conversationIds }) => {
        if (startMs < day1 + 60_000) {
          if (failDay1Once) {
            failDay1Once = false;
            return { complete: false, events: [] };
          }
          return {
            complete: true,
            events: [
              {
                eventId: "ev-r1",
                conversationId: "agent-parent",
                cents: 100,
                accountedTokens: 700,
              },
            ],
          };
        }
        const events: MatchedCursorUsageEvent[] = [
          { eventId: "ev-r2", conversationId: "agent-parent", cents: 150, accountedTokens: 700 },
        ];
        if (conversationIds.has("agent-fork")) {
          events.push({
            eventId: "ev-r3",
            conversationId: "agent-fork",
            cents: 75,
            accountedTokens: 700,
          });
        }
        return { complete: true, events };
      }),
    };

    const cost = new CursorSessionCost({
      resumed: true,
      readLineage: async () => lineage,
      readRuns: async (id) => runsByAgent[id] ?? [],
      readApiKey: async () => "api-key",
      fetcher,
      publish: (usd, turnId) => published.push({ usd, turnId }),
      retryDelaysMs: [100, 200],
      confirmDelayMs: 100,
      now: () => day3 + 120_000,
    });

    cost.refresh();
    await vi.runAllTimersAsync();
    expect(published).toEqual([{ usd: 2.5, turnId: undefined }]);

    lineage = ["agent-fork", "agent-parent"];
    cost.onRewind();
    cost.refresh("turn-3");
    await vi.runAllTimersAsync();
    cost.dispose();

    expect(published.at(-1)).toEqual({ usd: 3.25, turnId: "turn-3" });
    for (let i = 1; i < published.length; i += 1) {
      expect(published[i]!.usd).toBeGreaterThanOrEqual(published[i - 1]!.usd);
    }
  });

  test("fails closed without faking zero cost when the dashboard API errors", async () => {
    vi.useFakeTimers();
    const published: Array<{ usd: number; turnId?: string }> = [];
    const cost = new CursorSessionCost({
      resumed: false,
      readLineage: async () => ["agent-err"],
      readRuns: async () => [makeRun({ agentId: "agent-err", runId: "r-err" })],
      readApiKey: async () => "api-key",
      fetcher: {
        fetchWindow: vi.fn(async () => {
          throw new Error("HTTP 503");
        }),
      },
      publish: (usd, turnId) => published.push({ usd, turnId }),
      retryDelaysMs: [50, 100],
      confirmDelayMs: 50,
    });
    cost.refresh("turn-err");
    await vi.runAllTimersAsync();
    cost.dispose();
    expect(published).toEqual([]);
  });

  test("does not settle Turn 2 prematurely on Turn 1 subagent tokens while Turn 2 billing lags", async () => {
    vi.useFakeTimers();
    const turn1Start = BASE_TIME;
    const turn2Start = BASE_TIME + 60_000;
    const runs: LocalAgentRunDocument[] = [
      makeRun({
        agentId: "agent-sub",
        runId: "run-1",
        requestId: "req-1",
        turnNumber: 1,
        startedAt: turn1Start,
        endedAt: turn1Start + 10_000,
        usage: {
          inputTokens: 4_000,
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 5_000,
        },
      }),
    ];

    const ev1: MatchedCursorUsageEvent = {
      eventId: "ev-1",
      conversationId: "agent-sub",
      timestampMs: turn1Start + 1_000,
      cents: 147,
      accountedTokens: 92_000,
    };
    const ev2: MatchedCursorUsageEvent = {
      eventId: "ev-2",
      conversationId: "agent-sub",
      timestampMs: turn2Start + 1_000,
      cents: 40,
      accountedTokens: 10_500,
    };

    let turn2Polls = 0;
    const published: Array<{ usd: number; turnId?: string }> = [];
    const fetcher: CursorDashboardUsageFetcher = {
      fetchWindow: vi.fn(async () => {
        if (runs.length === 1) return { complete: true, events: [ev1] };
        turn2Polls += 1;
        return {
          complete: true,
          events: turn2Polls >= 4 ? [ev1, ev2] : [ev1],
        };
      }),
    };

    const cost = new CursorSessionCost({
      resumed: false,
      readLineage: async () => ["agent-sub"],
      readRuns: async () => [...runs],
      readApiKey: async () => "api-key",
      fetcher,
      publish: (usd, turnId) => published.push({ usd, turnId }),
      retryDelaysMs: [100, 100, 100, 100],
      confirmDelayMs: 50,
      now: () => turn2Start + 20_000,
    });

    cost.refresh("turn-1");
    await vi.runAllTimersAsync();
    expect(published).toContainEqual({ usd: 1.47, turnId: "turn-1" });

    runs.push(
      makeRun({
        agentId: "agent-sub",
        runId: "run-2",
        requestId: "req-2",
        turnNumber: 2,
        startedAt: turn2Start,
        endedAt: turn2Start + 5_000,
        usage: {
          inputTokens: 9_000,
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 10_000,
        },
      }),
    );
    cost.refresh("turn-2");
    await vi.runAllTimersAsync();
    cost.dispose();

    expect(published).not.toContainEqual({ usd: 1.47, turnId: "turn-2" });
    expect(published.at(-1)).toEqual({ usd: 1.87, turnId: "turn-2" });
  });

  test("bounds confirmation re-polls when usage events keep changing on every poll", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const published: Array<{ usd: number; turnId?: string }> = [];
    const fetcher: CursorDashboardUsageFetcher = {
      fetchWindow: vi.fn(async () => {
        polls += 1;
        return {
          complete: true,
          events: [
            {
              eventId: "ev-growing",
              conversationId: "agent-grow",
              timestampMs: BASE_TIME + 1_000,
              cents: 10 + polls,
              accountedTokens: 1_000 + polls * 100,
            },
          ],
        };
      }),
    };
    const cost = new CursorSessionCost({
      resumed: false,
      readLineage: async () => ["agent-grow"],
      readRuns: async () => [
        makeRun({
          agentId: "agent-grow",
          runId: "run-grow",
          usage: {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 600,
          },
        }),
      ],
      readApiKey: async () => "api-key",
      fetcher,
      publish: (usd, turnId) => published.push({ usd, turnId }),
      retryDelaysMs: [50, 100],
      confirmDelayMs: 50,
      now: () => BASE_TIME + 20_000,
    });

    cost.refresh("turn-grow");
    await vi.runAllTimersAsync();
    cost.dispose();

    expect(polls).toBeLessThanOrEqual(10);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((entry) => entry.turnId === undefined)).toBe(true);
  });
});
