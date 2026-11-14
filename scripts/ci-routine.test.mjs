  const cli = commands.find((step) => step.name === "cli units");
  assert.ok(cli.args.includes("**/*.e2e.test.ts"));
  const desktop = commands.find((step) => step.name === "desktop units");
  assert.ok(desktop.args.includes("scripts/after-pack.test.mjs"));
  assert.ok(
    commands
      .find((step) => step.name === "workflow and helper contracts")
      .args.includes("packages/desktop/scripts/after-pack.test.mjs"),
  );
  const docs = planCommands(selectChecks(["docs/agent-testing.md"], filters));
test("new Node test files require an explicit routine or package classification", () => {
  const results = ["success", "failure", "cancelled", "skipped", ""];
  for (const plan of results)
  const install = (job) =>
    job.steps.find((step) => step.name?.startsWith("Install locked dependencies"));
  assert.match(setup.run, /v26\.13\.0/);
  const tools = steps.find((step) => step.uses === "./.github/actions/setup-ci-tools");
  assert.equal(tools.with.actionlint, "true");
  const action = load(
    readFileSync(new URL("../.github/actions/setup-ci-tools/action.yml", import.meta.url), "utf8"),
  );
  const node = action.runs.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(node.with["node-version"], "26.13.0");
  assert.equal(node.with["package-manager-cache"], false);
  const mise = action.runs.steps.find((step) => step.uses?.startsWith("jdx/mise-action@"));
  assert.equal(mise.with.install, false);
  assert.equal(mise.with.cache, false);
  const activate = action.runs.steps.find((step) => step.name === "Activate exact mise runtime");
  assert.match(activate.run, /mise link node@26\.13\.0/);
  assert.match(activate.run, /readlink -f/);
  assert.match(activate.run, /11\.20\.0/);
