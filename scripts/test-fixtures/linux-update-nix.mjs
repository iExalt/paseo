// External Nix boundary for the real updater CLI rehearsal. Unknown operations fail closed.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
const directory = process.env.PASEO_UPDATE_FIXTURE;
assert.ok(directory);
const stateFile = join(directory, "nix-state.json");
const read = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (state) => writeFileSync(stateFile, JSON.stringify(state));
const closureFor = (output) => {
  const entry = JSON.parse(
    readFileSync(
      join(directory, process.env.PASEO_UPDATE_MAC ? "mac-closures.json" : "closures.json"),
      "utf8",
    ),
  )[output];
  assert.ok(entry, `Unknown fixture output ${output}`);
  return entry;
};
export function nix(args) {
  const state = read();
  state.calls.push(args);
  save(state);
  if (args[0] === "store" && args[1] === "info") return { status: 0, stdout: '{"trusted":true}' };
  if (args[0] === "config" && args[1] === "show") return { status: 0, stdout: "{}" };
  const outputs = args.filter((argument) => argument.startsWith("/nix/store/"));
  if (args[0] === "copy") {
    assert.equal(outputs.length, 1);
    closureFor(outputs[0]);
    if (process.env.PASEO_UPDATE_FAIL === "import") throw new Error("fixture interrupted import");
    if (!state.imported.includes(outputs[0])) state.imported.push(outputs[0]);
    save(state);
    return { status: 0, stdout: "" };
  }
  if (args[0] === "store" && ["copy-sigs", "verify"].includes(args[1])) {
    for (const output of outputs)
      assert.ok(state.imported.includes(output), "Output was never imported");
    return { status: 0, stdout: "" };
  }
  if (args[0] === "path-info") {
    const entries = {};
    for (const output of outputs)
      for (const entry of closureFor(output))
        entries[entry.path] = { narHash: entry.narHash, narSize: entry.narSize };
    return { status: 0, stdout: JSON.stringify(entries) };
  }
  throw new Error(`Unexpected fixture nix command: ${JSON.stringify(args)}`);
}
export function profileGenerations(profile) {
  return read().profiles[profile] ?? [];
}
export function setProfile(profile, outputPath) {
  const state = read();
  assert.ok(state.imported.includes(outputPath));
  const active =
    profile ===
    (process.env.PASEO_UPDATE_MAC
      ? join(process.env.HOME, "Library", "Application Support", "Paseo", "nix-update", "profile")
      : join(process.env.XDG_STATE_HOME, "paseo", "nix-update", "profile"));
  if (active && process.env.PASEO_UPDATE_FAIL === "select-before")
    throw new Error("fixture activation refused");
  const generations = state.profiles[profile] ?? [];
  if (generations.some((entry) => entry.current && entry.outputPath === outputPath)) return;
  for (const entry of generations) entry.current = false;
  const generation = Math.max(0, ...generations.map((entry) => entry.generation)) + 1;
  generations.push({ generation, outputPath, current: true });
  state.profiles[profile] = generations;
  mkdirSync(dirname(profile), { recursive: true });
  const generationLink = `${profile}-${generation}-link`;
  symlinkSync(outputPath, generationLink);
  try {
    unlinkSync(profile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  symlinkSync(generationLink, profile);
  save(state);
  if (active && process.env.PASEO_UPDATE_FAIL === "select-after") process.exit(73);
}
export function nixEnv(args) {
  const profile = args[args.indexOf("--profile") + 1];
  if (args.includes("--set")) {
    setProfile(profile, args.at(-1));
    return { status: 0, stdout: "", stderr: "" };
  }
  if (args.includes("--switch-generation")) {
    const state = read();
    const generation = Number(args[args.indexOf("--switch-generation") + 1]);
    assert.ok(state.profiles[profile].some((entry) => entry.generation === generation));
    for (const entry of state.profiles[profile]) entry.current = entry.generation === generation;
    unlinkSync(profile);
    symlinkSync(`${profile}-${generation}-link`, profile);
    save(state);
    return { status: 0, stdout: "", stderr: "" };
  }
  assert.ok(args.includes("--delete-generations"), "Unexpected fixture nix-env operation");
  const requested = new Set(args.slice(args.indexOf("--delete-generations") + 1));
  const state = read();
  state.profiles[profile] = (state.profiles[profile] ?? []).filter((entry) => {
    const keep =
      entry.current || (!requested.has("old") && !requested.has(String(entry.generation)));
    if (!keep) unlinkSync(`${profile}-${entry.generation}-link`);
    return keep;
  });
  save(state);
  return { status: 0, stdout: "" };
}
export async function extractNixCacheTar(_archive, cache) {
  mkdirSync(cache, { recursive: true });
}
