  const docs = planCommands(selectChecks(["docs/agent-testing.md"], filters));
  assert.match(setup.run, /v26\.13\.0/);
  assert.equal(node.with["node-version"], "26.13.0");
  assert.match(activate.run, /mise link node@26\.13\.0/);
