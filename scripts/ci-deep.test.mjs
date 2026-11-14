import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { removeOwnedTree } from "../packages/desktop/e2e/remove-owned-tree.mjs";
import {
  elevatedOwnedProcesses,
  ownedProcesses,
  verifyDeepCleanup,
} from "../.github/scripts/deep-cleanup.mjs";

test("owned temp cleanup removes read-only directories without following external symlinks", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "paseo-cleanup-"));
  const owned = join(fixture, "owned");
  const external = join(fixture, "external");
  try {
    await mkdir(join(owned, "readonly"), { recursive: true });
    await mkdir(external);
    await writeFile(join(external, "keep"), "unchanged");
    await writeFile(join(owned, "readonly", "remove"), "temporary");
    await symlink(external, join(owned, "external"), "dir");
    await chmod(external, 0o500);
    await chmod(join(owned, "readonly"), 0o500);
    await chmod(owned, 0o500);
    await removeOwnedTree(owned);
    await assert.rejects(lstat(owned), { code: "ENOENT" });
    assert.equal((await lstat(external)).mode & 0o777, 0o500);
    assert.equal(await readFile(join(external, "keep"), "utf8"), "unchanged");
  } finally {
    await removeOwnedTree(fixture);
  }
});

test("elevated cleanup is hosted-only, PID-only and fails closed", () => {
  const owner = randomUUID();
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  const run = (command, args, options) => {
    assert.equal(command, "sudo");
    assert.ok(args.includes(process.execPath));
    assert.deepEqual(args.slice(-3), ["--scan", "1001", owner]);
    assert.equal(options.timeout, 5_000);
    assert.equal(options.maxBuffer, 16 * 1024);
    return "[123]";
  };
  assert.deepEqual(elevatedOwnedProcesses(owner, { env, uid: 1001, run }), [123]);
  for (const invalid of [
    {},
    { GITHUB_ACTIONS: "true" },
    { ...env, RUNNER_ENVIRONMENT: "self-hosted" },
  ]) {
    assert.throws(
      () => elevatedOwnedProcesses(owner, { env: invalid, uid: 1001, run }),
      /GitHub-hosted only/,
    );
  }
  assert.throws(() => elevatedOwnedProcesses(owner, { env, uid: -1, run }), /Invalid original UID/);
  assert.throws(() => elevatedOwnedProcesses("-".repeat(36), { env, uid: 1001, run }));
  for (const output of ["not json", "{}", "[0]", "[1,1]", '["123"]']) {
    assert.throws(() => elevatedOwnedProcesses(owner, { env, uid: 1001, run: () => output }));
  }
  assert.throws(
    () =>
      elevatedOwnedProcesses(owner, {
        env,
        uid: 1001,
        run: () => {
          throw new Error("sudo denied");
        },
      }),
    /sudo denied/,
  );
});
test("deep workflow runs only for open release PRs or trusted dispatches", async () => {
  assert.deepEqual(Object.keys(workflow.on), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.pull_request, {
    branches: ["dev"],
  });
  const startsWith = (value, prefix) => value.startsWith(prefix);
        state: "open",
  assert.equal(admitted(pr), true);
      x.event.pull_request.state = "closed";
      x.event.pull_request.head.ref = "ci/github-workflows";
    assert.equal(admitted(rejected), false);
  assert.equal(admitted({ ...pr, event: { ...pr.event, action: "synchronize" } }), true);
  const dispatch = {
    repository: "iExalt/paseo",
    event_name: "workflow_dispatch",
    event: { repository: { private: false } },
    actor: "iExalt",
  };
