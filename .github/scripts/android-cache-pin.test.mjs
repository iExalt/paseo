const d = "d".repeat(64);
const e = "e".repeat(64);
const pin = () =>
  buildPin({
    version: "0.2.2",
    buildSha256: a,
    depsInputs: b,
    depsSha256: c,
    modulesInputs: d,
    modulesSha256: e,
  });
  assert.equal(pin().modules.key, `paseo-node-modules-v1-${d}-${e}`);
  // 0.2.1 published schema 1, without node_modules; the next release reads it.
  const { modules: _modules, ...v1 } = pin();
  assert.equal(parsePin(JSON.stringify({ ...v1, schemaVersion: 1 })).schemaVersion, 1);
    ["modules key inputs", (value) => (value.modules.inputs = a)],
    ["modules missing from schema 2", (value) => delete value.modules],
    ["modules in schema 1", (value) => (value.schemaVersion = 1)],
    ["schema", (value) => (value.schemaVersion = 3)],
test("Gradle caches restore regardless of inputs; node_modules only for identical inputs", () => {
  assert.deepEqual(planRestore(null, { deps: b, modules: d }), {
    build: null,
    deps: null,
    depsInputsMatch: false,
    modules: null,
  });
  assert.deepEqual(planRestore(pin(), { deps: b, modules: d }), {
    modules: { key: `paseo-node-modules-v1-${d}-${e}`, sha256: e },
  const changed = planRestore(pin(), { deps: a, modules: a });
  assert.equal(changed.modules, null);
});

