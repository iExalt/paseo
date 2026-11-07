import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  admit,
  controllerFiles,
  executeCandidate,
  verifyController,
} from "../.github/scripts/ci-candidate.mjs";

const root = new URL("../", import.meta.url);
const c = "a".repeat(40),
  s = "b".repeat(40);
function request(eventName = "workflow_dispatch", controllerSha = c, candidateSha = s) {
  const ref =
    eventName === "pull_request"
      ? "refs/pull/7/merge"
      : `refs/heads/ci-candidate/controller-${controllerSha.slice(0, 12)}`;
  const pr = {
    number: 7,
    state: "open",
    head: { sha: candidateSha, ref: "worker/ci-candidate", repo: { full_name: "iExalt/paseo" } },
    base: { ref: "dev", repo: { full_name: "iExalt/paseo" } },
  };
  const event = {
    repository: { full_name: "iExalt/paseo", private: false },
    number: 7,
    action: "opened",
    pull_request: structuredClone(pr),
    inputs: {
      controller_sha: controllerSha,
      candidate_sha: candidateSha,
      pr_number: "7",
      target: "controller",
    },
  };
  const env = {
    GITHUB_REPOSITORY: "iExalt/paseo",
    GITHUB_EVENT_NAME: eventName,
    GITHUB_ACTOR: "iExalt",
    GITHUB_TRIGGERING_ACTOR: "iExalt",
    GITHUB_REF: ref,
    GITHUB_SHA: controllerSha,
    GITHUB_WORKFLOW_SHA: controllerSha,
    GITHUB_WORKFLOW_REF: `iExalt/paseo/.github/workflows/ci-candidate.yml@${ref}`,
  };
  return { event, pr, env };
}

test("dispatch preserves distinct roles and bootstrap allows C=S", () => {
  let r = request();
  assert.deepEqual(admit(r.event, r.pr, r.env), {
    controllerSha: c,
    candidateSha: s,
    target: "controller",
    prNumber: 7,
  });
  r = request("pull_request", c, c);
  assert.equal(admit(r.event, r.pr, r.env).candidateSha, c);
});

test("admission rejects identity, authority and disabled-target counterexamples", () => {
  const cases = [
    (r) => {
      r.event.inputs.controller_sha = "abc";
    },
    (r) => {
      r.event.inputs.candidate_sha = "B".repeat(40);
    },
    (r) => {
      r.event.inputs.target = "";
    },
    (r) => {
      r.event.inputs.target = "controller,controller";
    },
    (r) => {
      r.event.inputs.target = "windows-x64";
    },
    (r) => {
      r.env.GITHUB_ACTOR = "other";
    },
    (r) => {
      r.env.GITHUB_TRIGGERING_ACTOR = "other";
    },
    (r) => {
      r.env.GITHUB_REF = "refs/heads/dev";
    },
    (r) => {
      r.env.GITHUB_SHA = s;
    },
    (r) => {
      r.env.GITHUB_WORKFLOW_SHA = s;
    },
    (r) => {
      r.env.GITHUB_WORKFLOW_REF = "wrong";
    },
    (r) => {
      r.event.repository.private = true;
    },
    (r) => {
      r.pr.state = "closed";
    },
    (r) => {
      r.pr.head.sha = c;
    },
    (r) => {
      r.pr.head.repo.full_name = "someone/paseo";
    },
    (r) => {
      r.pr.base.ref = "other";
    },
    (r) => {
      delete r.event.inputs;
    },
  ];
  for (const change of cases) {
    const r = request();
    change(r);
    assert.throws(() => admit(r.event, r.pr, r.env));
  }
  for (const action of ["synchronize", "reopened"]) {
    const r = request("pull_request", c, c);
    r.event.action = action;
    assert.throws(() => admit(r.event, r.pr, r.env));
  }
});

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "candidate-controller-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const controller = join(directory, "controller");
  mkdirSync(controller);
  git(controller, "init", "-q");
  for (const file of [...controllerFiles, ".github/candidate-proof.json"]) {
    mkdirSync(dirname(join(controller, file)), { recursive: true });
    copyFileSync(new URL(file, root), join(controller, file));
  }
  git(controller, "add", ".");
  git(controller, "commit", "-qm", "fixture controller");
  const controllerSha = git(controller, "rev-parse", "HEAD");
  const candidate = join(directory, "candidate");
  git(directory, "clone", "-q", controller, candidate);
  writeFileSync(
    join(candidate, ".github/candidate-proof.json"),
    JSON.stringify({ kind: "paseo-candidate-self-check", marker: "only-in-S" }),
  );
  git(candidate, "add", ".");
  git(candidate, "commit", "-qm", "fixture candidate");
  return {
    directory,
    controller,
    candidate,
    controllerSha,
    candidateSha: git(candidate, "rev-parse", "HEAD"),
  };
}

test("fixed candidate execution distinguishes S and retains failure/deadline cleanup", (t) => {
  const f = fixture(t);
  const evidence = join(f.directory, "evidence");
  const plan = {
    controllerSha: f.controllerSha,
    candidateSha: f.candidateSha,
    target: "controller",
    prNumber: 7,
  };
  executeCandidate(plan, f.candidate, evidence);
  let receipt = JSON.parse(readFileSync(join(evidence, "receipt.json"), "utf8"));
  assert.equal(receipt.marker, "only-in-S");
  assert.notEqual(receipt.controllerSha, receipt.candidateSha);
  assert.equal(receipt.cleanup, true);
  assert.throws(() => executeCandidate(plan, f.controller, evidence), /Wrong candidate/);
  assert.throws(
    () => executeCandidate({ ...plan, target: "controller-failure" }, f.candidate, evidence),
    /Candidate command failed/,
  );
  receipt = JSON.parse(readFileSync(join(evidence, "receipt.json"), "utf8"));
  assert.equal(receipt.exitCode, 17);
  assert.equal(receipt.cleanup, true);
  writeFileSync(
    join(f.candidate, ".github/scripts/ci-candidate-self-check.mjs"),
    "setInterval(() => {}, 1000);\n",
  );
  git(f.candidate, "add", ".");
  git(f.candidate, "commit", "-qm", "deadline fixture");
  plan.candidateSha = git(f.candidate, "rev-parse", "HEAD");
  assert.throws(() => executeCandidate(plan, f.candidate, evidence, 100), /ETIMEDOUT/);
  receipt = JSON.parse(readFileSync(join(evidence, "receipt.json"), "utf8"));
  assert.equal(receipt.error, "ETIMEDOUT");
  assert.equal(receipt.cleanup, true);
});

test("workflow retains the secret-free ref boundary and separate candidate job", () => {
  const text = readFileSync(new URL(".github/workflows/ci-candidate.yml", root), "utf8");
  assert.match(text, /types: \[opened\]/);
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(text, /  execute:\n    needs: admission/);
  assert.match(text, /path: candidate/);
  assert.equal((text.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.doesNotMatch(
    text,
    /secrets\.|contents: write|actions: write|pull_request_target|actions\/cache|cache-mode:/,
  );
  assert.match(text, /controller-\$\{CONTROLLER_SHA:0:12\}/);
  assert.match(text, /retention-days: 1/);
});

test("serialized admission CLI rejects source, authority and runtime-blob failures", (t) => {
  const f = fixture(t);
  const eventFile = join(f.directory, "event.json"),
    prFile = join(f.directory, "pr.json"),
    output = join(f.directory, "output");
  const cli = join(f.controller, ".github/scripts/ci-candidate.mjs");
  const run = (r) => {
    writeFileSync(eventFile, JSON.stringify(r.event));
    writeFileSync(prFile, JSON.stringify(r.pr));
    return spawnSync(process.execPath, [cli, "admit", prFile], {
      env: { ...process.env, ...r.env, GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output },
      encoding: "utf8",
      timeout: 10_000,
    });
  };
  const dispatch = () => request("workflow_dispatch", f.controllerSha, f.candidateSha);
  const bootstrap = () => request("pull_request", f.controllerSha, f.controllerSha);
  assert.equal(run(dispatch()).status, 0);
  assert.equal(run(bootstrap()).status, 0);
  const acceptedOutput = readFileSync(output, "utf8");
  const cases = [
    [
      dispatch,
      (r) => {
        r.event.inputs.controller_sha = "abc";
      },
      /full lowercase/,
    ],
    [
      dispatch,
      (r) => {
        r.env.GITHUB_REF = "refs/heads/dev";
      },
      /AssertionError/,
    ],
    [
      dispatch,
      (r) => {
        r.env.GITHUB_ACTOR = "other";
      },
      /Only the owner/,
    ],
    [
      dispatch,
      (r) => {
        r.event.inputs.target = "windows-x64";
      },
      /disabled target/,
    ],
    [
      dispatch,
      (r) => {
        r.pr = {};
      },
      /AssertionError/,
    ],
    [
      bootstrap,
      (r) => {
        r.pr.head.sha = f.candidateSha;
      },
      /PR head moved/,
    ],
    [
      bootstrap,
      (r) => {
        r.env.GITHUB_WORKFLOW_SHA = "f".repeat(40);
      },
      /Command failed/,
    ],
  ];
  for (const [makeRequest, change, expected] of cases) {
    const r = makeRequest();
    change(r);
    const result = run(r);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, expected);
    assert.equal(readFileSync(output, "utf8"), acceptedOutput, "Rejected input must emit no plan");
  }
  writeFileSync(join(f.controller, ".github/scripts/ci-candidate-self-check.mjs"), "changed\n");
  git(f.controller, "add", ".");
  git(f.controller, "commit", "-qm", "changed runtime blob");
  const changed = git(f.controller, "rev-parse", "HEAD");
  git(f.controller, "checkout", "--detach", "-q", f.controllerSha);
  assert.throws(() => verifyController(f.controller, f.controllerSha, changed), /blob differs/);
  const r = bootstrap();
  r.env.GITHUB_WORKFLOW_SHA = changed;
  assert.match(run(r).stderr, /Runtime controller blob differs/);
  assert.equal(readFileSync(output, "utf8"), acceptedOutput);
});
