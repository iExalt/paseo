import { describe, expect, it } from "vitest";
import { assignShards } from "../../vitest.sequencer.js";
import { parseDurations, renderDurations } from "../../scripts/refresh-test-durations.js";
import durations from "../../test-durations.json" with { type: "json" };

describe("recorded test durations", () => {
  it("reads file totals from a CI log and records only files that move a shard", () => {
    const log = [
      "2026-10-31T18:44:56.2Z \x1b[32m✓\x1b[39m src/b.test.ts \x1b[2m(19 tests)\x1b[22m 115430ms",
      "2026-10-31T18:44:56.3Z    ✓ a slow test inside it 5144ms",
      "2026-10-31T18:44:57.0Z  ❯ src/a.test.ts (3 tests | 1 skipped) 2049ms",
      "2026-10-31T18:44:58.0Z  ✓ src/fast.test.ts (2 tests) 1999ms",
    ].join("\n");
    const parsed = parseDurations(log);
    expect([...parsed]).toEqual([
      ["src/b.test.ts", 115.43],
      ["src/a.test.ts", 2.049],
      ["src/fast.test.ts", 1.999],
    ]);
    expect(JSON.parse(renderDurations(parsed))).toEqual({
      "src/a.test.ts": 2,
      "src/b.test.ts": 115.4,
    });
  });
});

describe("duration-balanced server shards", () => {
  const recorded = Object.keys(durations);
  const files = [
    ...recorded,
    ...Array.from({ length: 380 }, (_, index) => `src/new-${index}.test.ts`),
  ];

  it("runs every file exactly once whatever the order lanes list them in", () => {
    const shards = assignShards(files, 3);
    expect(assignShards(files.toReversed(), 3)).toEqual(shards);
    expect(shards.flat().sort()).toEqual([...files].sort());
  });

  it("puts the three slowest recorded files on different shards", () => {
    const slowest = Object.entries(durations)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([file]) => file);
    const shards = assignShards(files, 3);
    const shardOf = (file: string) => shards.findIndex((shard) => shard.includes(file));
    expect(slowest.map(shardOf).sort()).toEqual([0, 1, 2]);
  });
});
