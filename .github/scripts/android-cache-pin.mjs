//   plan                          hash this checkout's cache inputs and read the latest release's
//                                 pin; write both to GITHUB_OUTPUT (needs ImageOS and NPM_VERSION)
//   pin <out> <version>           write the pin JSON from BUILD_SHA256, DEPS_INPUTS, DEPS_SHA256,
//                                 MODULES_INPUTS and MODULES_SHA256
const MODULES_KEY = /^paseo-node-modules-v1-([0-9a-f]{64})-([0-9a-f]{64})$/;
export const modulesKey = (inputs, sha256) => `paseo-node-modules-v1-${inputs}-${sha256}`;
export function buildPin({
  version,
  buildSha256,
  depsInputs,
  depsSha256,
  modulesInputs,
  modulesSha256,
}) {
    schemaVersion: 2,
    modules: {
      key: modulesKey(modulesInputs, modulesSha256),
      sha256: modulesSha256,
      inputs: modulesInputs,
    },
// Throws unless the pin is exactly the expected shape and each key names its
// digest. Schema 1 (0.2.1) has no node_modules entry.
  const entries = { 1: ["build", "deps"], 2: ["build", "deps", "modules"] }[pin?.schemaVersion];
  if (!entries || !fields(pin, ["schemaVersion", "version", ...entries])) {
  const keyed = [
    ["deps", DEPS_KEY],
    ["modules", MODULES_KEY],
  ].filter(([name]) => entries.includes(name));
  if (
    !fields(pin.build, ["key", "sha256"]) ||
    keyed.some(([name]) => !fields(pin[name], ["key", "sha256", "inputs"]))
  ) {
  const digests = [
    pin.build.sha256,
    ...keyed.flatMap(([name]) => [pin[name].sha256, pin[name].inputs]),
  ];
  for (const value of digests) {
  for (const [name, pattern] of keyed) {
    const key = pattern.exec(pin[name].key);
    if (key?.[1] !== pin[name].inputs || key?.[2] !== pin[name].sha256) {
      throw new Error(`The ${name} cache key does not name its inputs and digest`);
    }
}

// node_modules replaces npm ci, so it is restored only for identical inputs.
export function planRestore(pin, { deps, modules }) {
  if (!pin) return { build: null, deps: null, depsInputsMatch: false, modules: null };
    depsInputsMatch: pin.deps.inputs === deps,
    modules:
      pin.modules?.inputs === modules ? { key: pin.modules.key, sha256: pin.modules.sha256 } : null,
async function planCommand() {
  let pin = null;
  try {
    pin = await fetchLatestPin();
  } catch (error) {
    warn(`No usable Android cache pin (${error.message})`);
  }
  const restore = planRestore(pin, { deps, modules });
  if (pin && !restore.modules) {
    );
  }
  await output({
    deps_inputs: deps,
    modules_inputs: modules,
    build_key: restore.build?.key ?? "",
    build_sha256: restore.build?.sha256 ?? "",
    deps_key: restore.deps?.key ?? "",
    deps_sha256: restore.deps?.sha256 ?? "",
    deps_inputs_match: restore.depsInputsMatch,
    modules_key: restore.modules?.key ?? "",
    modules_sha256: restore.modules?.sha256 ?? "",
  });
}

    await planCommand();
      modulesInputs: process.env.MODULES_INPUTS,
      modulesSha256: process.env.MODULES_SHA256,
    console.log(`Pinned ${pin.build.key}, ${pin.deps.key} and ${pin.modules.key}`);
