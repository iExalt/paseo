// Rewrites test-durations.json from one Routine CI run's server lanes, so shard
// weights come from hosted runners under real worker contention. Run it after a
// change moves server test time noticeably:
//   npx tsx scripts/refresh-test-durations.ts [run-id]
// Without a run id it reads the latest successful dev push. Needs gh.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Matches the sequencer's unrecorded weight: shorter files barely move a shard.
const RECORDED_SECONDS = 2;
// Routine CI runs only on the fork; gh's default repository may be upstream.
const REPOSITORY = "iExalt/paseo";
const LANES = ["routine (server-1)", "routine (server-2)", "routine (server-3)"];

interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function parseDurations(log: string): Map<string, number> {
  const seconds = new Map<string, number>();
  // oxlint-disable-next-line no-control-regex -- CI logs keep ANSI colours.
  const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
  for (const match of plain.matchAll(/^\S*\s*[✓❯×] (src\/\S+) \(\d+ tests?[^)]*\) (\d+)ms$/gm))
    seconds.set(match[1], Number(match[2]) / 1000);
  return seconds;
}

export function renderDurations(seconds: Map<string, number>): string {
  const recorded = [...seconds]
    .filter(([, value]) => value >= RECORDED_SECONDS)
    .sort(([a], [b]) => Number(a > b) - Number(a < b))
    .map(([file, value]) => [file, Math.round(value * 10) / 10]);
  return `${JSON.stringify(Object.fromEntries(recorded), null, 2)}\n`;
}

function main(runId?: string): void {
  const run =
    runId ??
    gh([
      "run",
      "list",
      `--repo=${REPOSITORY}`,
      "--workflow=ci.yml",
      "--branch=dev",
      "--event=push",
      "--status=success",
      "--limit=1",
      "--json=databaseId",
      "--jq=.[0].databaseId",
    ]).trim();
  const jobs: WorkflowJob[] = JSON.parse(
    gh(["api", `repos/${REPOSITORY}/actions/runs/${run}/jobs?per_page=100`, "--jq=.jobs"]),
  );
  const seconds = new Map<string, number>();
  for (const lane of LANES) {
    const job = jobs.find((item) => item.name === lane);
    if (job?.conclusion !== "success") throw new Error(`Run ${run} has no successful ${lane}`);
    const log = gh([
      "api",
      "--allow-escape-sequences",
      `repos/${REPOSITORY}/actions/jobs/${job.id}/logs`,
    ]);
    const files = parseDurations(log);
    if (files.size === 0) throw new Error(`${lane} in run ${run} reported no test files`);
    for (const [file, value] of files) seconds.set(file, value);
  }
  writeFileSync(new URL("../test-durations.json", import.meta.url), renderDurations(seconds));
  console.log(`Recorded ${seconds.size} files from run ${run}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
