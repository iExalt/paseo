import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGitVersion, planRebase, validateRebase } from "./rebase-dev.mjs";

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
  check("zstd available", () => invoke("zstd", ["--version"]).trim());
  check("routine process visibility", () => {
    assert.equal(
      invoke("node", [
        "--input-type=module",
        "-e",
        `
      if (process.platform === "linux") {
        const { ownedProcesses } = await import("./.github/scripts/deep-cleanup.mjs");
        const { randomUUID } = await import("node:crypto");
        ownedProcesses(randomUUID());
      }
      console.log("routine-process-scan-ok");
    `,
      ]).trim(),
      "routine-process-scan-ok",
    );
  });
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

const ROUTINE_COMMAND = ["mise", "run", "--skip-tools", "ci:routine"];

export async function runLocalRoutine({
  repositoryPath,
  receiptPath,
  validate = validateRebase,
  run = command,
}) {
  const receipt = { repositoryPath: resolve(repositoryPath), command: ROUTINE_COMMAND };
  try {
    for (const name of ["dev", "upstream", "resolutions"])
      receipt[name] = run(
        "git",
        ["rev-parse", "--verify", `refs/codex/snapshot/${name}^{commit}`],
        { cwd: receipt.repositoryPath },
      ).trim();
    receipt.testedSha = await validate({ repositoryPath: receipt.repositoryPath });
    receipt.testedTree = run("git", ["rev-parse", `${receipt.testedSha}^{tree}`], {
      cwd: receipt.repositoryPath,
    }).trim();
    receipt.exitCode = 0;
  } catch (error) {
    receipt.exitCode = 1;
    receipt.error = error.message;
  }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

export function assertRoutineReceipt({ routineReceipt, run = command, ...inputs }) {
  assert.ok(routineReceipt, "Run the full routine plan on the clean replay and pass its receipt");
  const receipt = JSON.parse(readFileSync(routineReceipt, "utf8"));
  assert.equal(receipt.exitCode, 0, "Local routine plan did not pass");
  assert.deepEqual(receipt.command, ROUTINE_COMMAND, "Receipt used a different test plan");
  assert.ok(isAbsolute(receipt.repositoryPath ?? ""), "Receipt must identify the replay checkout");
  for (const name of ["dev", "upstream", "resolutions"])
    assert.equal(
      receipt[name],
      inputs[name],
      `Routine receipt ${name} differs from the frozen input`,
    );
  for (const name of ["testedSha", "testedTree"])
    assert.match(receipt[name] ?? "", /^[a-f0-9]{40}$/, `Missing routine ${name}`);
  const git = (...args) => run("git", args, { cwd: receipt.repositoryPath }).trim();
  assert.equal(
    git("rev-parse", "HEAD"),
    receipt.testedSha,
    "Replay HEAD moved since routine validation",
  );
  assert.equal(
    git("rev-parse", "HEAD^{tree}"),
    receipt.testedTree,
    "Replay tree differs from the routine receipt",
  );
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all"),
    "",
    "Replay is dirty after routine validation",
  );
  return receipt.testedSha;
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
        name: "local routine plan",
        ok: true,
        detail: assertRoutineReceipt(options),
      });
    } catch (error) {
      result.checks.push({ name: "local routine plan", ok: false, detail: error.message });
    }
  }
  result.ok = result.checks.every((entry) => entry.ok);
  result.readyForDispatch = !options.environmentOnly && result.ok;
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result =
      process.argv[2] === "routine"
        ? await runLocalRoutine({ repositoryPath: process.argv[3], receiptPath: process.argv[4] })
        : await runPreflight({
            upstream: process.argv[2],
            dev: process.argv[3],
            resolutions: process.argv[4],
            environmentOnly: process.argv[5] === "--environment-only",
            routineReceipt: process.argv[5] === "--environment-only" ? undefined : process.argv[5],
          });
    console.log(JSON.stringify(result, null, 2));
    if (result.exitCode === 1 || result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
