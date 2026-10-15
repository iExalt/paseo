import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkArchiveListing, verifyBuildCache } from "./build-cache-provenance.mjs";
import { assertNativeActor } from "./native-candidate-authority.mjs";
import { normalizeLock } from "./windows-modules-cache.mjs";
import { repositorySaveCeiling } from "./windows-predecessor-cache.mjs";

// ccache objects and Gradle build-cache entries for the fork APK. Both key each
// output on its inputs, so a near key only lowers the hit rate; a version bump
// still restores every native object and about 500 Gradle tasks.
// Only a dispatched dev writer may produce them; the candidate verifies the
// attestation of the entry it actually restored before extracting. Entries are
// immutable: replace a bad one with `gh cache delete <key>` and another writer
// dispatch.
export const writer = "android-build-cache.yml";
export const prefix = "paseo-android-build-v1-";
export const roots = ["ccache", "gradle"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function androidRecipe(source, ccacheVersion) {
  assert.match(ccacheVersion, /^\d+\.\d+(\.\d+)?$/);
  const read = (file) => readFileSync(join(source, file));
  return {
    schema: 1,
    lock: sha256(JSON.stringify(normalizeLock(JSON.parse(read("package-lock.json"))))),
    wrapper: sha256(read("packages/app/android/gradle/wrapper/gradle-wrapper.properties")),
    ccache: ccacheVersion,
  };
}

export const androidKey = (recipe) => `${prefix}${sha256(JSON.stringify(recipe))}`;

// About 150 MB in the spike; the whole archive is reserved against the ceiling.
export const androidSaveAllowed = (usage, bytes) => usage + bytes <= repositorySaveCeiling;

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, "iExalt/paseo");
  assert.equal(process.env.GITHUB_REF, "refs/heads/dev");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assertNativeActor(process.env);
  const directory = join(process.env.RUNNER_TEMP, "android-build-cache");
  const archive = join(process.env.RUNNER_TEMP, "paseo-android-build-cache.tar");
  const output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  const [operation] = process.argv.slice(2);
  if (operation === "key") {
    const version = execFileSync("ccache", ["--print-version"], { encoding: "utf8" }).trim();
    const key = androidKey(androidRecipe(process.cwd(), version));
    output("key", key);
    output("archive", archive);
    output("directory", directory);
    console.log(`Android build cache key ${key}`);
  } else if (operation === "archive") {
    assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(
      process.env.GITHUB_WORKFLOW_REF,
      `iExalt/paseo/.github/workflows/${writer}@refs/heads/dev`,
    );
    assert.equal(existsSync(archive), false);
    execFileSync("tar", ["-cf", archive, "-C", directory, ...roots], { timeout: 300_000 });
    const list = (flags) =>
      execFileSync("tar", [flags, archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split(/\r?\n/)
        .filter(Boolean);
    checkArchiveListing(
      list("-tf").map((name) => name.replace(/\/$/, "")),
      list("-tvf"),
      roots,
    );
    console.log(`Archived Android build caches (${statSync(archive).size} bytes)`);
  } else if (operation === "budget") {
    const bytes = statSync(archive).size;
    let usage;
    try {
      usage = JSON.parse(
        execFileSync("gh", ["api", "repos/iExalt/paseo/actions/cache/usage"], {
          encoding: "utf8",
          timeout: 15000,
        }),
      ).active_caches_size_in_bytes;
      assert.ok(Number.isSafeInteger(usage) && usage >= 0);
    } catch {
      output("save", "false");
      console.log("::warning::Cache usage unavailable; Android build caches not saved.");
      return;
    }
    const allowed = androidSaveAllowed(usage, bytes);
    output("save", String(allowed));
    console.log(JSON.stringify({ usage, bytes, save: allowed }));
    if (!allowed)
      console.log(
        "::warning::Repository cache headroom is too low; Android build caches not saved.",
      );
  } else if (operation === "self-verify") {
    const digest = await verifyBuildCache(archive, { key: process.env.PASEO_CACHE_KEY, writer });
    console.log(`Writer attestation verifies for ${digest}`);
  } else if (operation === "verify") {
    // Verify the entry actually restored, which may be an older key under the prefix.
    const key = process.env.PASEO_CACHE_KEY;
    try {
      assert.ok(key.startsWith(prefix));
      const digest = await verifyBuildCache(archive, { key, writer });
      for (const root of roots) assert.equal(existsSync(join(directory, root)), false);
      mkdirSync(directory, { recursive: true });
      execFileSync("tar", ["-xf", archive, "-C", directory], { timeout: 300_000 });
      output("verified", "true");
      console.log(`Restored attested Android build caches ${key} (${digest})`);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      output("verified", "false");
      console.log(
        `::warning::Android build caches failed provenance (${error.message}); building without it.`,
      );
    } finally {
      rmSync(archive, { force: true });
    }
  } else throw new Error(`Unknown Android build cache operation: ${operation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
