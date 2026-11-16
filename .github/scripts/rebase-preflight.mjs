import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  check("pinned mirror", () => {
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
  check("candidate push dry run", () => {
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

export async function runPreflight(options = {}, plan = planRebase) {
  const result = preflight(options);
  try {
    const capture = await plan({ repositoryPath: options.repositoryPath ?? process.cwd() });
    assert.equal(capture.upstream, options.upstream, "Captured ledger target moved");
    result.checks.push({
      name: "replayPlan ledger",
      ok: true,
      detail: `${capture.retained.length} retained, ${capture.drops.length} drops`,
    });
  } catch (error) {
    result.checks.push({ name: "replayPlan ledger", ok: false, detail: error.message });
  }
  result.ok = result.checks.every((entry) => entry.ok);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPreflight({ upstream: process.argv[2] });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
