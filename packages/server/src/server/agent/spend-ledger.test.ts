import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SpendLedger, spendDelta, summarizeSpend } from "./spend-ledger.js";

const logger = pino({ level: "silent" });

describe("spendDelta", () => {
  test("counts a first reading whole, an increase as the difference, and a drop as a new count", () => {
    expect(spendDelta(undefined, 2)).toBe(2);
    expect(spendDelta(2, 2.5)).toBe(0.5);
    expect(spendDelta(2.5, 2.5)).toBe(0);
    expect(spendDelta(2.5, 0.25)).toBe(0.25);
    expect(spendDelta(undefined, 0)).toBe(0);
  });
});

describe("summarizeSpend", () => {
  test("buckets entries by day in the caller's time zone", () => {
    const entries = [
      // 22:00 on Oct 17 in New York, the day after in UTC.
      { at: "2026-10-18T02:00:00.000Z", provider: "claude", agentId: "a", usd: 1, totalUsd: 1 },
      { at: "2026-10-11T15:00:00.000Z", provider: "claude", agentId: "a", usd: 2, totalUsd: 3 },
      { at: "2026-09-30T15:00:00.000Z", provider: "claude", agentId: "a", usd: 4, totalUsd: 7 },
      {
        at: "2026-10-01T15:00:00.000Z",
        provider: "codex",
        agentId: "b",
        usd: 8,
        totalUsd: 8,
        carried: true,
      },
    ];
    const now = new Date("2026-10-18T03:00:00.000Z");
    const summary = summarizeSpend({
      entries,
      trackingSince: "2026-10-01T00:00:00.000Z",
      now,
      timeZone: "America/New_York",
    });
    expect(summary.providers).toEqual([
      {
        provider: "codex",
        todayUsd: 0,
        last7DaysUsd: 0,
        thisMonthUsd: 8,
        allTimeUsd: 8,
        carriedUsd: 8,
      },
      {
        provider: "claude",
        todayUsd: 1,
        last7DaysUsd: 3,
        thisMonthUsd: 3,
        allTimeUsd: 7,
        carriedUsd: 0,
      },
    ]);
    const utc = summarizeSpend({ entries, trackingSince: null, now, timeZone: "UTC" });
    expect(utc.providers.find((p) => p.provider === "claude")?.todayUsd).toBe(1);
    // Oct 11 is in the seven days ending Oct 17 in New York, but not those ending Oct 18 in UTC.
    expect(utc.providers.find((p) => p.provider === "claude")?.last7DaysUsd).toBe(1);
    const unknownZone = summarizeSpend({
      entries,
      trackingSince: null,
      now,
      timeZone: "Nowhere/X",
    });
    expect(unknownZone.providers).toEqual(utc.providers);
  });
});

describe("SpendLedger", () => {
  let home: string;
  let now: Date;
  const ledger = (seed?: ConstructorParameters<typeof SpendLedger>[0]["seed"]) =>
    new SpendLedger({ paseoHome: home, logger, seed, now: () => now });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "spend-ledger-"));
    now = new Date("2026-10-18T00:00:00.000Z");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("seeds stored costs as carried, then records only increases across restarts", async () => {
    const first = ledger(async () => [
      { agentId: "old", provider: "claude", usd: 40, at: "2026-10-10T12:00:00.000Z" },
    ]);
    await first.initialize();
    now = new Date("2026-10-18T01:00:00.000Z");
    // The seeded session goes on: only what it spent since its stored cost is new.
    await first.record({
      agentId: "old",
      provider: "claude",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      totalUsd: 41.5,
    });
    // A session from before tracking with no stored cost reports its whole history at once.
    await first.record({
      agentId: "resumed",
      provider: "codex",
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
      totalUsd: 3,
    });
    await first.record({
      agentId: "new",
      provider: "codex",
      createdAt: new Date("2026-10-18T00:30:00.000Z"),
      totalUsd: 0.5,
    });

    // After a restart the same lifetime reading adds nothing.
    const second = ledger(async () => {
      throw new Error("an existing ledger is not seeded again");
    });
    await second.initialize();
    await second.record({
      agentId: "old",
      provider: "claude",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      totalUsd: 41.5,
    });
    const summary = await second.summarize("UTC");
    expect(summary.trackingSince).toBe("2026-10-18T00:00:00.000Z");
    expect(summary.providers).toEqual([
      {
        provider: "claude",
        todayUsd: 1.5,
        last7DaysUsd: 1.5,
        thisMonthUsd: 41.5,
        allTimeUsd: 41.5,
        carriedUsd: 40,
      },
      {
        provider: "codex",
        todayUsd: 3.5,
        last7DaysUsd: 3.5,
        thisMonthUsd: 3.5,
        allTimeUsd: 3.5,
        carriedUsd: 3,
      },
    ]);
  });

  test("retains zero, tokens and unknown run counts through reads, retries and restart", async () => {
    const first = ledger();
    const base = { agentId: "a", provider: "claude", createdAt: now };
    const cursor = {
      ...base,
      agentId: "c",
      provider: "cursor-sdk",
      turnId: "one",
      usage: { inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 12, outputTokens: 5 },
    };
    await first.record({ ...base, totalUsd: 1.25, turnId: "priced" });
    await first.record({ ...base, provider: "pi", agentId: "b", totalUsd: 0, turnId: "free" });
    await first.record(cursor);
    const before = await first.summarize("UTC");
    expect(before.totals).toMatchObject({
      todayUsd: 1.25,
      allTimeUsd: 1.25,
      unknownCostRuns: { today: 1, allTime: 1 },
    });
    expect(before.providers).toContainEqual(
      expect.objectContaining({ provider: "pi", allTimeUsd: 0 }),
    );
    const file = join(home, "spend", "ledger.jsonl");
    const original = readFileSync(file, "utf8");
    expect(original).toContain(JSON.stringify(cursor.usage));
    const second = ledger();
    await second.record(cursor);
    expect(await second.summarize("UTC")).toEqual(before);
    expect(await second.summarize("UTC")).toEqual(before);
    expect(readFileSync(file, "utf8")).toBe(original);
    now = new Date("2026-10-19T01:00:00.000Z");
    await second.record({ ...cursor, turnId: "two" });
    expect((await second.summarize()).totals?.unknownCostRuns).toEqual({
      today: 1,
      last7Days: 2,
      thisMonth: 2,
      allTime: 2,
    });
    await second.record({ ...cursor, totalUsd: 0.5 });
    expect((await second.summarize()).totals).toMatchObject({
      todayUsd: 0,
      allTimeUsd: 1.75,
      unknownCostRuns: { today: 1, allTime: 1 },
    });
  });

  test("imports dated historical runs once into an existing cost-only ledger", async () => {
    await ledger().record({ agentId: "a", provider: "claude", createdAt: now, totalUsd: 2 });
    let imports = 0;
    const open = () =>
      new SpendLedger({
        paseoHome: home,
        logger,
        now: () => now,
        historicalRuns: async function* () {
          imports++;
          yield {
            provider: "cursor-sdk",
            agentId: "b",
            turnId: "cursor-run",
            at: "2026-10-14T12:00:00Z",
            usage: { cacheWriteTokens: 20 },
          };
        },
      });
    const before = await open().summarize();
    expect(before.totals).toMatchObject({
      todayUsd: 2,
      unknownCostRuns: { today: 0, last7Days: 1, allTime: 1 },
    });
    expect(await open().summarize()).toEqual(before);
    expect(imports).toBe(1);
  });

  test("a broken history import leaves live accounting available and retries next startup", async () => {
    const run = {
      agentId: "old",
      provider: "cursor-sdk",
      at: now.toISOString(),
      turnId: "old-run",
      usage: { outputTokens: 2 },
    };
    let attempts = 0;
    const open = () =>
      new SpendLedger({
        paseoHome: home,
        logger,
        now: () => now,
        historicalRuns: async function* () {
          yield run;
          if (++attempts === 1) throw new Error("corrupt turn");
        },
      });
    const live = open();
    await live.record({
      agentId: "new",
      provider: "claude",
      turnId: "priced",
      createdAt: now,
      totalUsd: 1.5,
    });
    const expected = await live.summarize();
    expect(expected.totals).toMatchObject({ todayUsd: 1.5, unknownCostRuns: { allTime: 1 } });
    expect(attempts).toBe(1);
    expect(await open().summarize()).toEqual(expected);
    expect(await open().summarize()).toEqual(expected);
    expect(attempts).toBe(2);
  });

  test("skips a line cut short by a crash", async () => {
    await ledger().initialize();
    const file = join(home, "spend", "ledger.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"at":"2026-10-18T00:00`);
    await ledger().record({
      agentId: "a",
      provider: "claude",
      createdAt: now,
      totalUsd: 2,
    });
    const summary = await ledger().summarize("UTC");
    expect(summary.providers.map((p) => p.allTimeUsd)).toEqual([2]);
  });
});
