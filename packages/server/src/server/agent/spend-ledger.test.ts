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
