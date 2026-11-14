import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import durations from "./test-durations.json" with { type: "json" };

// Files under 2 s are not recorded; most take well under a second.
const unrecorded = 0.4;
const weights: Record<string, number> = durations;

const relativePath = (root: string, spec: TestSpecification) =>
  path.relative(root, spec.moduleId).split(path.sep).join("/");

// Sharding by file count put the slowest files together (one shard took 112 s
// against 62 s and 72 s). Assign the longest recorded files first, each to the
// lightest shard. Stale durations only skew balance: every lane computes the
// same complete partition, so each file still runs exactly once.
export function assignShards(files: string[], count: number): string[][] {
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  // Plain code-unit order keeps ties independent of the runner's locale data.
  const byPath = (a: string, b: string) => Number(a > b) - Number(a < b);
  const ordered = [...files].sort(
    (a, b) => (weights[b] ?? unrecorded) - (weights[a] ?? unrecorded) || byPath(a, b),
  );
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.load += weights[file] ?? unrecorded;
    lightest.files.push(file);
  }
  return shards.map((shard) => shard.files);
}

export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    const selected = new Set(
      assignShards(
        files.map((spec) => relativePath(root, spec)),
        shard!.count,
      )[shard!.index - 1],
    );
    return files.filter((spec) => selected.has(relativePath(root, spec)));
  }

  // Start the longest files first so none begins last on an idle worker.
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root } = this.ctx.config;
    const weight = (spec: TestSpecification) => weights[relativePath(root, spec)] ?? unrecorded;
    return [...files].sort((a, b) => weight(b) - weight(a));
  }
}
