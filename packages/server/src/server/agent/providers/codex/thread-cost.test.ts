import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { CodexThreadCost } from "./thread-cost.js";

type UsageReply = { usd: number; tokens?: number } | "pending" | "fail" | (() => Promise<unknown>);

function usage(usdMicros: number, totalTokens?: number): unknown {
  return {
    threadUsage: {
      estimatedUsageUsdMicros: usdMicros,
      groups: totalTokens === undefined ? [] : [{ totalTokens }],
    },
  };
}

function createTracker(replies: Record<string, UsageReply>) {
  const reads: string[] = [];
  const published: number[] = [];
  const tracker = new CodexThreadCost({
    logger: createTestLogger(),
    readUsage: async (threadId) => {
      reads.push(threadId);
      const reply = replies[threadId];
      if (reply === undefined || reply === "fail") throw new Error(`no usage for ${threadId}`);
      if (reply === "pending") return usage(0);
      if (typeof reply === "function") return reply();
      return usage(reply.usd, reply.tokens ?? 1);
    },
    publish: (usd) => published.push(usd),
  });
  return { tracker, reads, published };
}

describe("CodexThreadCost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("sums the root and each thread spawned in its tree once", async () => {
    const { tracker, reads, published } = createTracker({
      root: { usd: 1_000 },
      child: { usd: 2_000 },
      grandchild: { usd: 3_000 },
      stranger: { usd: 9_000 },
      foreign: { usd: 9_000 },
    });
    tracker.reset("root", { resumed: false });
    tracker.addSpawnedThreads(null, ["child"]);
    tracker.addSpawnedThreads("child", ["grandchild"]);
    tracker.addSpawnedThreads("root", ["child"]);
    tracker.addSpawnedThreads("stranger", ["foreign"]);
    tracker.refresh("all");
    tracker.refresh(["child"]);

    await vi.advanceTimersByTimeAsync(0);

    expect(published).toEqual([0.006]);
    expect(reads.sort()).toEqual(["child", "grandchild", "root"]);
  });

  test("retries until accounting covers the reported tokens instead of publishing zero", async () => {
    const replies: Record<string, UsageReply> = { root: "pending" };
    const { tracker, reads, published } = createTracker(replies);
    tracker.reset("root", { resumed: false });
    tracker.reportTokens(null, 100);
    tracker.refresh("all");
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([]);

    replies.root = { usd: 500, tokens: 60 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(published).toEqual([0.0005]);

    replies.root = { usd: 900, tokens: 100 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(published).toEqual([0.0005, 0.0009]);

    const readsWhenSettled = reads.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).toHaveLength(readsWhenSettled);
  });

  test("never lowers a known reading and stops retrying at the limit", async () => {
    const replies: Record<string, UsageReply> = { root: { usd: 1_000 }, child: { usd: 2_000 } };
    const { tracker, reads, published } = createTracker(replies);
    tracker.reset("root", { resumed: false });
    tracker.addSpawnedThreads(null, ["child"]);
    tracker.refresh("all");
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([0.003]);

    replies.root = { usd: 1_100 };
    replies.child = { usd: 1_500 };
    tracker.refresh("all");
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([0.003, 0.0031]);

    replies.child = "fail";
    tracker.reportTokens("child", 80);
    tracker.refresh(["child"]);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(published).toEqual([0.003, 0.0031]);
    // One read per trigger, then one per retry delay.
    expect(reads.filter((threadId) => threadId === "child")).toHaveLength(1 + 1 + 1 + 7);
  });

  test("reads at most four threads at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<unknown>((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve(usage(1_000, 1));
        }, 10),
      );
    };
    const children = ["a", "b", "c", "d", "e", "f"];
    const { tracker, published } = createTracker(
      Object.fromEntries(["root", ...children].map((threadId) => [threadId, slow])),
    );
    tracker.reset("root", { resumed: false });
    tracker.addSpawnedThreads(null, children);
    tracker.refresh("all");
    await vi.advanceTimersByTimeAsync(100);

    expect(peak).toBe(4);
    expect(published).toEqual([0.007]);
  });

  test("drops a reading that arrives after the root thread changed", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const { tracker, published } = createTracker({
      old: () => new Promise((resolve) => (resolveOld = resolve)),
      next: { usd: 4_000 },
    });
    tracker.reset("old", { resumed: false });
    tracker.refresh("all");
    await vi.advanceTimersByTimeAsync(0);
    tracker.reset("next", { resumed: false });
    tracker.refresh("all");
    resolveOld(usage(9_000, 1));
    await vi.advanceTimersByTimeAsync(0);

    expect(published).toEqual([0.004]);
  });

  test("after a resume, publishes nothing until every known thread has a reading", async () => {
    const replies: Record<string, UsageReply> = { root: { usd: 1_000 }, child: "fail" };
    const { tracker, published } = createTracker(replies);
    tracker.reset("root", { resumed: true });
    tracker.addSpawnedThreads(null, ["child"]);
    tracker.refresh("all");
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual([]);

    replies.child = { usd: 2_000 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(published).toEqual([0.003]);
  });
});
