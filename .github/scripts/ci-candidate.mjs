import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeepCleanup } from "./deep-cleanup.mjs";

const repository = "iExalt/paseo";
const workflow = ".github/workflows/ci-candidate.yml";
export const controllerFiles = [
  ".github/actions/setup-ci-tools/action.yml",
  workflow,
  ".github/scripts/ci-candidate.mjs",
  ".github/scripts/ci-candidate-self-check.mjs",
  ".github/scripts/deep-cleanup.mjs",
  "scripts/ci-candidate.test.mjs",
];
const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
const sha = (value) => {
  assert.equal(typeof value, "string", "Missing source SHA");
  assert.match(value, /^[a-f0-9]{40}$/, "Source must be a full lowercase commit SHA");
  return value;
};

function validatePr(pr, number, candidateSha) {
  assert.equal(pr.number, number);
  assert.equal(pr.state, "open", "Candidate PR must remain open");
  assert.equal(pr.head?.repo?.full_name, repository, "Candidate must be same-repository");
  assert.equal(pr.base?.repo?.full_name, repository);
  assert.equal(pr.base?.ref, "dev");
  assert.equal(pr.head?.sha, candidateSha, "Candidate PR head moved");
  assert.notEqual(pr.head?.ref, "dev");
}

export function admit(event, pr, env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, repository, "Wrong repository");
  assert.equal(event.repository?.full_name, repository);
  assert.equal(event.repository.private, false, "Repository must be public");
  assert.equal(env.GITHUB_ACTOR, "iExalt", "Only the owner may request execution");
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, "iExalt", "Only the owner may retry execution");
  let controllerSha, candidateSha, target, number;
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    assert.equal(event.action, "opened", "Bootstrap runs only once on PR open");
    assert.equal(event.pull_request?.head?.ref, "worker/ci-candidate");
    assert.equal(event.pull_request?.head?.repo?.full_name, repository);
    assert.equal(event.pull_request?.base?.ref, "dev");
    controllerSha = candidateSha = sha(event.pull_request.head.sha);
    target = "controller";
    number = event.number;
    assert.equal(env.GITHUB_REF, `refs/pull/${number}/merge`);
    sha(env.GITHUB_SHA);
    sha(env.GITHUB_WORKFLOW_SHA);
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Unsupported event");
    const inputs = event.inputs;
    controllerSha = sha(inputs?.controller_sha);
    candidateSha = sha(inputs?.candidate_sha);
    target = inputs?.target;
    assert.match(inputs?.pr_number ?? "", /^[1-9][0-9]*$/, "Invalid PR number");
    number = Number(inputs.pr_number);
    assert.equal(
      env.GITHUB_REF,
      `refs/heads/ci-candidate/controller-${controllerSha.slice(0, 12)}`,
    );
    assert.equal(env.GITHUB_SHA, controllerSha, "Controller ref moved");
    assert.equal(env.GITHUB_WORKFLOW_SHA, controllerSha, "Workflow differs from controller");
  }
  assert.ok(Number.isSafeInteger(number) && number > 0, "Invalid PR number");
  assert.ok(["controller", "controller-failure"].includes(target), "Unknown or disabled target");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflow}@${env.GITHUB_REF}`);
  validatePr(pr, number, candidateSha);
  return { controllerSha, candidateSha, target, prNumber: number };
}

export function verifyController(cwd, controllerSha, workflowSha) {
  sha(controllerSha);
  sha(workflowSha);
  assert.equal(git(cwd, "rev-parse", "HEAD"), controllerSha, "Wrong controller checkout");
  for (const file of controllerFiles) {
    const reviewed = git(cwd, "rev-parse", `${controllerSha}:${file}`);
    const running = git(cwd, "rev-parse", `${workflowSha}:${file}`);
    assert.equal(running, reviewed, `Runtime controller blob differs: ${file}`);
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function cleanupCandidate(result, owner) {
  if (result?.pid) {
    signalGroup(result.pid, "SIGKILL");
    const deadline = performance.now() + 5_000;
    while (signalGroup(result.pid, 0)) {
      assert.ok(performance.now() < deadline, "Candidate process group survived cleanup");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  // Local /proc can be restricted; Actions must also prove marker cleanup.
  if (process.env.GITHUB_ACTIONS === "true") verifyDeepCleanup(owner);
}

export function executeCandidate(plan, candidateRoot, directory, timeout = 60_000) {
  const { controllerSha, candidateSha, target } = plan;
  sha(controllerSha);
  sha(candidateSha);
  assert.ok(["controller", "controller-failure"].includes(target), "Unknown or disabled target");
  assert.equal(git(candidateRoot, "rev-parse", "HEAD"), candidateSha, "Wrong candidate checkout");
  assert.equal(git(candidateRoot, "status", "--porcelain"), "", "Candidate checkout is dirty");
  for (const key of Object.keys(process.env)) {
    assert.ok(!key.startsWith("E2E_") && !key.startsWith("PASEO_REPLICA_CACHE_MEASUREMENT"));
  }
  assert.throws(() => readFileSync(resolve(candidateRoot, ".env.test")), { code: "ENOENT" });
  const proof = JSON.parse(
    readFileSync(resolve(candidateRoot, ".github/candidate-proof.json"), "utf8"),
  );
  assert.equal(proof.kind, "paseo-candidate-self-check");
  assert.match(proof.marker, /^[a-zA-Z0-9-]{1,100}$/);
  mkdirSync(directory, { recursive: true });
  const owner = randomUUID();
  const started = Date.now();
  let result,
    cleanup = false;
  try {
    result = spawnSync(
      process.execPath,
      [resolve(candidateRoot, ".github/scripts/ci-candidate-self-check.mjs"), target, directory],
      {
        cwd: candidateRoot,
        detached: true,
        stdio: "inherit",
        timeout,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          SOURCE_SHA: candidateSha,
          CI_DEEP_OWNER: owner,
          GH_TOKEN: "",
          NODE_AUTH_TOKEN: "",
        },
      },
    );
  } finally {
    try {
      cleanupCandidate(result, owner);
      cleanup = true;
    } finally {
      writeFileSync(
        resolve(directory, "receipt.json"),
        JSON.stringify(
          {
            ...plan,
            marker: proof.marker,
            runtimeRef: process.env.GITHUB_REF,
            workflowSha: process.env.GITHUB_WORKFLOW_SHA,
            runId: process.env.GITHUB_RUN_ID,
            attempt: process.env.GITHUB_RUN_ATTEMPT,
            exitCode: result?.status ?? null,
            signal: result?.signal ?? null,
            error: result?.error?.code ?? null,
            cleanupScope:
              process.env.GITHUB_ACTIONS === "true" ? "process-group-and-marker" : "process-group",
            elapsedMs: Date.now() - started,
            cleanup,
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Candidate command failed");
  const observed = JSON.parse(readFileSync(resolve(directory, "candidate-result.json"), "utf8"));
  assert.equal(observed.sourceSha, candidateSha);
  assert.equal(observed.marker, proof.marker, "Wrong candidate proof marker");
  assert.equal(observed.target, target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "admit") {
    assert.equal(args.length, 1, "Usage: ci-candidate.mjs admit PR_JSON");
    const plan = admit(
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      JSON.parse(readFileSync(args[0], "utf8")),
    );
    verifyController(root, plan.controllerSha, process.env.GITHUB_WORKFLOW_SHA);
    for (const [key, value] of Object.entries(plan))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    console.log(JSON.stringify(plan));
  } else {
    assert.equal(command, "execute", "Usage: ci-candidate.mjs admit|execute");
    assert.equal(args.length, 6, "execute C S TARGET PR_NUMBER CANDIDATE_DIR EVIDENCE_DIR");
    const [controllerSha, candidateSha, target, prNumber, candidateRoot, directory] = args;
    verifyController(root, controllerSha, process.env.GITHUB_WORKFLOW_SHA);
    executeCandidate(
      { controllerSha, candidateSha, target, prNumber: Number(prNumber) },
      resolve(candidateRoot),
      resolve(directory),
    );
  }
}
