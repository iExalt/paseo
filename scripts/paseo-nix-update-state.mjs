import assert from "node:assert/strict";
import { compareForkVersions, parseForkVersion } from "../packages/protocol/src/fork-version.ts";
import { FORK_RELEASE_LINEAGE } from "../packages/protocol/src/release-manifest-v2.ts";

const outputPattern = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-paseo-desktop-[^/\s]+$/;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function keys(value, expected) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid updater record");
  assert.deepEqual(Object.keys(value).sort(), expected.toSorted(), "Unsupported updater fields");
}

export function validateTarget(target, { pending = false } = {}) {
  keys(
    target,
    target.lineage === "legacy-v1"
      ? ["lineage", "generation", "identity", "outputPath"]
      : ["lineage", "generation", "identity", "outputPath", "version"],
  );
  assert.ok(
    (pending && target.generation === null) ||
      (Number.isSafeInteger(target.generation) && target.generation > 0),
    "Invalid target generation",
  );
  assert.match(target.outputPath, outputPattern);
  if (target.lineage === "legacy-v1") {
    assert.match(target.identity, /^[a-f0-9]{40}-[1-9][0-9]*$/);
    assert.notEqual(target.generation, null, "Legacy recovery requires a retained generation");
  } else {
    assert.equal(target.lineage, FORK_RELEASE_LINEAGE);
    parseForkVersion(target.version);
    assert.match(target.identity, /^[a-f0-9]{40}-v/);
    assert.equal(target.identity.slice(42), target.version);
    assert.ok(target.outputPath.endsWith(`-paseo-desktop-${target.version}`));
  }
  return target;
}

export function emptyState() {
  return {
    schemaVersion: 2,
    lineage: FORK_RELEASE_LINEAGE,
    highWater: null,
    current: null,
    generations: [],
    legacyRecovery: null,
  };
}

export function validateState(state) {
  keys(state, [
    "schemaVersion",
    "lineage",
    "highWater",
    "current",
    "generations",
    "legacyRecovery",
  ]);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.lineage, FORK_RELEASE_LINEAGE);
  assert.ok(Array.isArray(state.generations));
  const generations = new Set();
  const versions = new Set();
  let highest = null;
  for (const target of state.generations) {
    validateTarget(target);
    assert.equal(target.lineage, FORK_RELEASE_LINEAGE);
    assert.ok(
      !generations.has(target.generation) && !versions.has(target.version),
      "Conflicting generation/version",
    );
    generations.add(target.generation);
    versions.add(target.version);
    if (!highest || compareForkVersions(target.version, highest.version) > 0) highest = target;
  }
  if (state.legacyRecovery !== null) {
    validateTarget(state.legacyRecovery);
    assert.equal(state.legacyRecovery.lineage, "legacy-v1");
    assert.ok(
      !generations.has(state.legacyRecovery.generation),
      "Legacy generation conflicts with fork state",
    );
  }
  assert.ok(
    equal(state.highWater, highest),
    "State must retain the highest activated fork version",
  );
  if (state.current !== null) {
    validateTarget(state.current);
    assert.ok(
      [state.legacyRecovery, ...state.generations].some((target) => equal(target, state.current)),
      "Current generation has no recorded release identity",
    );
  } else {
    assert.equal(state.generations.length, 0, "Activated state cannot lose its current generation");
    assert.equal(state.legacyRecovery, null);
  }
  return state;
}

/**
 * Retention after a completed switch: the active generation, the high-water
 * release that reactivation returns to, and, while those coincide, the newest
 * older generation so rollback still has a target. Everything else is dropped.
 */
export function retainedState(state) {
  validateState(state);
  if (state.current === null) return state;
  const kept = [state.current, state.highWater];
  if (state.highWater === null || equal(state.current, state.highWater)) {
    const previous = [state.legacyRecovery, ...state.generations]
      .filter((entry) => entry && entry.generation < state.current.generation)
      .sort((a, b) => b.generation - a.generation)[0];
    if (previous) kept.push(previous);
  }
  const keep = (entry) => kept.some((target) => equal(target, entry));
  return validateState({
    ...state,
    generations: state.generations.filter(keep),
    legacyRecovery:
      state.legacyRecovery && keep(state.legacyRecovery) ? state.legacyRecovery : null,
  });
}

export function assertCurrent(state, actual) {
  validateState(state);
  assert.ok(
    state.current === null
      ? actual === null
      : actual?.generation === state.current.generation &&
          actual?.outputPath === state.current.outputPath,
    "Managed profile changed outside the updater; manual recovery is required",
  );
}

export function planTransaction(state, action, target) {
  validateState(state);
  validateTarget(target, { pending: true });
  assert.ok(["activate", "migrate", "rollback", "reactivate-high-water"].includes(action));
  if (action === "activate" || action === "migrate") {
    assert.equal(target.lineage, FORK_RELEASE_LINEAGE);
    assert.equal(target.generation, null);
    assert.ok(
      !state.highWater || compareForkVersions(target.version, state.highWater.version) > 0,
      "Release must exceed the fork semver high-water mark",
    );
    if (action === "migrate") {
      assert.equal(state.highWater, null);
      assert.equal(state.current?.lineage, "legacy-v1");
    } else {
      assert.ok(
        state.highWater !== null || state.current === null,
        "Existing legacy installation requires explicit manual migration",
      );
    }
  } else {
    assert.notEqual(state.current, null);
    assert.ok(
      [state.legacyRecovery, ...state.generations].some((entry) => equal(entry, target)),
      "Recovery target is not a recorded retained generation",
    );
    assert.ok(!equal(target, state.current), "Recovery target is already active");
    if (action === "reactivate-high-water") assert.ok(equal(target, state.highWater));
    else
      assert.ok(
        target.generation < state.current.generation,
        "Rollback requires a previous generation",
      );
  }
  return {
    schemaVersion: 2,
    lineage: FORK_RELEASE_LINEAGE,
    action,
    before: structuredClone(state),
    target: structuredClone(target),
  };
}

export function recoverTransaction(journal, actual) {
  keys(journal, ["schemaVersion", "lineage", "action", "before", "target"]);
  assert.equal(journal.schemaVersion, 2);
  assert.equal(journal.lineage, FORK_RELEASE_LINEAGE);
  planTransaction(journal.before, journal.action, journal.target);
  const { before, target } = journal;
  const unchanged =
    before.current === null
      ? actual === null
      : actual?.generation === before.current.generation &&
        actual?.outputPath === before.current.outputPath;
  if (unchanged) return { state: before, switched: false };
  assert.ok(
    actual &&
      actual.outputPath === target.outputPath &&
      Number.isSafeInteger(actual.generation) &&
      actual.generation > 0,
    "Interrupted activation selected an unexpected output; manual recovery is required",
  );
  if (target.generation !== null)
    assert.equal(
      actual.generation,
      target.generation,
      "Interrupted recovery selected a different retained generation",
    );
  const updated = structuredClone(before);
  updated.current = { ...target, generation: actual.generation };
  if (target.generation === null) {
    assert.ok(
      !before.generations.some((entry) => entry.generation === actual.generation) &&
        before.legacyRecovery?.generation !== actual.generation,
      "Activation reused a conflicting generation",
    );
    updated.generations.push(updated.current);
    updated.highWater = updated.current;
  }
  validateState(updated);
  return { state: updated, switched: true };
}

/** One real orchestration path for activation, migration and recovery. */
export async function reconcileTransaction(adapters) {
  const journal = await adapters.readJournal();
  if (!journal) return null;
  // Receipt and closure verification precede state writes, including journal replay.
  await adapters.verifyTarget(journal.target);
  const result = recoverTransaction(journal, await adapters.current());
  const stored = await adapters.readState();
  assert.ok(
    stored === null || equal(stored, journal.before) || equal(stored, result.state),
    "State changed during an interrupted transaction; manual recovery is required",
  );
  if (stored === null)
    assert.equal(
      journal.before.highWater,
      null,
      "Previously activated state disappeared during recovery",
    );
  if (result.switched) await adapters.writeState(result.state);
  await adapters.clearJournal();
  return { ...result, action: journal.action };
}

export async function executeTransaction(state, action, target, adapters) {
  const journal = planTransaction(state, action, target);
  assertCurrent(state, await adapters.current());
  await adapters.verifyTarget(target);
  await adapters.writeJournal(journal);
  await adapters.selectTarget(target);
  const result = await reconcileTransaction(adapters);
  assert.ok(result?.switched, "Nix did not select the intended release output");
  return result.state;
}
