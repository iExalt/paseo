import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertGitVersion, planRebase } from "./rebase-dev.mjs";

export function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${file} ${args.join(" ")}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`,
    );
  return result.stdout;
}

export function assertGitHubOrigin({ repositoryPath = process.cwd(), run = command } = {}) {
  const invoke = (args) =>
    run("git", ["remote", "get-url", ...args, "origin"], { cwd: repositoryPath }).trim();
  const fetchUrl = invoke([]);
  const pushUrls = invoke(["--push", "--all"]).split("\n");
  const canonical =
    /^(?:https:\/\/github\.com\/iExalt\/paseo|git@github\.com:iExalt\/paseo|ssh:\/\/git@github\.com\/iExalt\/paseo)(?:\.git)?$/i;
  assert.ok(canonical.test(fetchUrl), "origin fetch URL must target GitHub iExalt/paseo");
  assert.equal(pushUrls.length, 1, "origin must have exactly one push URL");
  assert.ok(canonical.test(pushUrls[0]), "origin push URL must target GitHub iExalt/paseo");
}

// The runner is injectable so failure aggregation never needs live credentials.
export function preflight({ upstream, repositoryPath = process.cwd(), run = command } = {}) {
  assert.match(upstream ?? "", /^[a-f0-9]{40}$/, "Pass the pinned upstream SHA");
  const checks = [];
  const invoke = (file, args, options = {}) => run(file, args, { cwd: repositoryPath, ...options });
  const git = (...args) => invoke("git", args).trim();
  const check = (name, operation) => {
    try {
      checks.push({ name, ok: true, detail: operation() ?? "ok" });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  };
  let originReady = false;
  check("GitHub origin binding", () => {
    assertGitHubOrigin({ repositoryPath, run });
    originReady = true;
  });
  const remoteCheck = (name, operation) =>
    check(name, () => {
      assert.ok(originReady, "origin binding failed; remote check skipped");
      return operation();
    });
  check("upstream-sync paused", () => {
    const workflow = JSON.parse(
      invoke("gh", ["api", "repos/iExalt/paseo/actions/workflows/upstream-sync.yml"]),
    );
    assert.equal(workflow.state, "disabled_manually");
  });
  for (const workflow of ["upstream-sync.yml", "rebase-dev.yml"]) {
    check(`${workflow} idle`, () => {
      for (const state of ["queued", "in_progress", "waiting", "pending", "requested"]) {
        const runs = JSON.parse(
          invoke("gh", [
            "api",
            `repos/iExalt/paseo/actions/workflows/${workflow}/runs?status=${state}&per_page=1`,
          ]),
        );
        assert.equal(runs.total_count, 0, `${workflow} has ${state} runs`);
      }
    });
  }
  remoteCheck("pinned mirror", () => {
    assert.equal(git("ls-remote", "origin", "refs/heads/upstream/main").split(/\s/)[0], upstream);
  });
  check("Git >= 2.55", () => assertGitVersion(git("--version")));
  check("signed commit identity", () => {
    const tree = git("rev-parse", "HEAD^{tree}");
    const commit = git("commit-tree", "-S", tree, "-m", "chore: probe rebase signing");
    assert.equal(git("show", "-s", "--format=%G? %ce", commit), "G cman101202@gmail.com");
    return "G cman101202@gmail.com (unreferenced throwaway commit)";
  });
  check("GitHub authentication", () => {
    invoke("gh", ["auth", "status"]);
    assert.equal(
      JSON.parse(invoke("gh", ["api", "user"])).login,
      "iExalt",
      "Workflow requires active iExalt actor",
    );
  });
  remoteCheck("candidate push dry run", () => {
    const destination = `refs/heads/rebase-candidate/preflight-${process.pid}`;
    return git("push", "--dry-run", "origin", `HEAD:${destination}`);
  });
  check("clean tree", () => {
    assert.equal(
      git("status", "--porcelain", "--untracked-files=all"),
      "",
      "Tracked or unignored generated files remain",
    );
  });
  check("Mise nounset startup", () =>
    invoke("zsh", ["-euc", "source ~/.zshenv; mise --version; mise exec -- node --version"]),
  );
  check("pinned Node", () => {
    const versions = readFileSync(`${repositoryPath}/.tool-versions`, "utf8");
    const version = /^nodejs\s+(\S+)/m.exec(versions)?.[1];
    assert.ok(version, "Missing nodejs pin");
    assert.equal(invoke("node", ["--version"]).trim(), `v${version}`);
  });
  check("pinned npm", () => {
    const workflow = readFileSync(`${repositoryPath}/.github/workflows/rebase-dev.yml`, "utf8");
    const version = /npm --version\)" = ([\d.]+)/.exec(workflow)?.[1];
    assert.ok(version, "Missing workflow npm pin");
    assert.equal(invoke("npm", ["--version"]).trim(), version);
  });
  return { ok: checks.every((entry) => entry.ok), upstream, checks };
}

const ROUTINE_WORKFLOW = "Routine CI";
const CACHE_JOB = "Refresh installed dependency cache";

// Hosted Routine CI on a pull request proves the replay only when the PR head
// is a signed `-s ours` merge of frozen dev whose tree is the replay tree: dev
// is then an ancestor, so GitHub's merge ref tree equals the head tree. The
// pull_request plan scopes only the format step to changed files, so the
// whole-repo format check runs here on the replay itself.
export async function assertHostedRoutine({
  replayPath,
  routineRun,
  dev,
  upstream,
  resolutions,
  run = command,
}) {
  assert.ok(
    replayPath && routineRun,
    "Pass the clean replay path and its hosted Routine CI run ID",
  );
  assert.match(String(routineRun), /^\d+$/, "Routine run ID must be numeric");
  const cwd = resolve(replayPath);
  const git = (...args) => run("git", args, { cwd }).trim();
  const inputs = { dev, upstream, resolutions };
  for (const name of Object.keys(inputs))
    assert.equal(
      git("rev-parse", "--verify", `refs/codex/snapshot/${name}^{commit}`),
      inputs[name],
      `Replay ${name} differs from the frozen input`,
    );
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all"),
    "",
    "Replay checkout is dirty",
  );
  const candidate = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const api = (path) => JSON.parse(run("gh", ["api", `repos/iExalt/paseo/${path}`], { cwd }));
  const workflowRun = api(`actions/runs/${routineRun}`);
  assert.equal(workflowRun.name, ROUTINE_WORKFLOW, "Run is not Routine CI");
  assert.equal(workflowRun.event, "pull_request", "Routine run must come from the candidate PR");
  assert.equal(workflowRun.run_attempt, 1, "Cite the first attempt; reruns are not accepted");
  assert.equal(workflowRun.status, "completed", "Routine run has not completed");
  assert.equal(workflowRun.conclusion, "success", "Routine run did not succeed");
  const head = workflowRun.head_sha;
  assert.match(head ?? "", /^[a-f0-9]{40}$/, "Routine run has no head SHA");
  const pr = workflowRun.pull_requests?.find((entry) => entry.head?.sha === head);
  assert.equal(pr?.base?.sha, dev, "Routine PR base must be the frozen dev");
  assert.equal(
    git("rev-parse", `${head}^{tree}`),
    tree,
    "Routine head tree differs from the replay tree",
  );
  assert.equal(
    git("rev-list", "--parents", "-n", "1", head),
    `${head} ${candidate} ${dev}`,
    "Routine head must merge frozen dev into the replay HEAD",
  );
  const jobs = api(`actions/runs/${routineRun}/attempts/1/jobs?per_page=100`).jobs ?? [];
  const routine = await import(pathToFileURL(`${cwd}/.github/scripts/ci-routine.mjs`).href);
  const filters = JSON.parse(readFileSync(`${cwd}/.github/ci-paths.json`, "utf8"));
  // Only dev pushes refresh the dependency cache, so a pull request skips it.
  const expected = [
    "plan",
    "Routine CI required",
    ...routine.planMatrix(routine.selectChecks(null, filters)).lane.map(routine.routineJobName),
  ].sort();
  const actual = jobs
    .filter((job) => !(job.name === CACHE_JOB && job.conclusion === "skipped"))
    .map((job) => `${job.name}: ${job.conclusion}`)
    .sort();
  assert.deepEqual(
    actual,
    expected.map((name) => `${name}: success`).sort(),
    "Routine jobs must be the full lane matrix, all successful",
  );
  const changed = git("diff", "--no-renames", "--name-only", "-z", dev, head)
    .split("\0")
    .filter(Boolean);
  const unscoped = (files) =>
    routine
      .planCommands(routine.selectChecks(files, filters), cwd)
      .filter((step) => step.name !== "format");
  assert.deepEqual(
    unscoped(changed),
    unscoped(null),
    "Pull request plan differs from the full routine beyond the format step",
  );
  run("npm", ["run", "format:check"], { cwd, timeout: 600_000 });
  return `${routineRun} at ${head}, tree ${tree}`;
}

export async function runPreflight(options = {}, plan = planRebase) {
  for (const name of ["dev", "resolutions"])
    assert.match(options[name] ?? "", /^[a-f0-9]{40}$/, `Pass the frozen ${name} SHA`);
  const result = preflight(options);
  try {
    assert.ok(
      result.checks.some((row) => row.name === "GitHub origin binding" && row.ok),
      "origin binding failed; ledger check skipped",
    );
    const capture = await plan({ repositoryPath: options.repositoryPath ?? process.cwd() });
    result.inputs = {
      dev: capture.dev,
      upstream: capture.upstream,
      resolutions: capture.resolutions,
    };
    for (const name of ["dev", "upstream", "resolutions"])
      assert.equal(
        capture[name],
        options[name],
        `Captured ${name} moved; review and re-freeze inputs`,
      );
    result.checks.push({
      name: "replayPlan ledger",
      ok: true,
      detail: `${capture.retained.length} retained, ${capture.drops.length} drops`,
    });
  } catch (error) {
    result.checks.push({ name: "replayPlan ledger", ok: false, detail: error.message });
  }
  result.mode = options.environmentOnly ? "environment-only" : "dispatch";
  if (!options.environmentOnly) {
    try {
      result.checks.push({
        name: "hosted routine",
        ok: true,
        detail: await assertHostedRoutine(options),
      });
    } catch (error) {
      result.checks.push({ name: "hosted routine", ok: false, detail: error.message });
    }
  }
  result.ok = result.checks.every((entry) => entry.ok);
  result.readyForDispatch = !options.environmentOnly && result.ok;
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const environmentOnly = process.argv[5] === "--environment-only";
    const result = await runPreflight({
      upstream: process.argv[2],
      dev: process.argv[3],
      resolutions: process.argv[4],
      environmentOnly,
      replayPath: environmentOnly ? undefined : process.argv[5],
      routineRun: environmentOnly ? undefined : process.argv[6],
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
