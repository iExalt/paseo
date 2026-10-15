import { describe, expect, it } from "vitest";
import { assignShards } from "../../vitest.sequencer.js";
import durations from "../../test-durations.json" with { type: "json" };

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
