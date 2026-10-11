const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function assertProfilePackages(manifest, expected) {
  assert.equal(manifest.version, 3);
  assert.ok(manifest.elements && !Array.isArray(manifest.elements));
  const actual = Object.values(manifest.elements).flatMap((element) => {
    assert.equal(element.active, true);
    assert.ok(Array.isArray(element.storePaths));
    return element.storePaths;
  });
  assert.deepEqual(actual.sort(), [...expected].sort(), "Exact owned profile packages");
}

function profileExecutables(profile, canonical) {
  assert.ok(path.isAbsolute(profile));
  const result = {
    executablePath: path.join(profile, "bin/paseo-desktop"),
    cliPath: path.join(profile, "bin/paseo"),
  };
  for (const key of Object.keys(result)) {
    assert.equal(
      fs.realpathSync(result[key]),
      fs.realpathSync(canonical[key]),
      "Profile executable must resolve to its exact evaluated package",
    );
  }
  return result;
}

function changeProfile(profile, action, outputs, artifactFile) {
  assert.ok(path.isAbsolute(profile));
  assert.ok(["add", "remove"].includes(action));
  assert.equal(outputs.length, 2);
  for (const output of outputs) assert.match(output, /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/);
  execFileSync("nix", ["profile", action, "--profile", profile, "--offline", ...outputs], {
    stdio: "inherit",
    timeout: 60000,
  });
  const manifest = JSON.parse(
    execFileSync("nix", ["profile", "list", "--profile", profile, "--json"], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  assertProfilePackages(manifest, action === "add" ? outputs : []);
  fs.writeFileSync(artifactFile, JSON.stringify(manifest, null, 2));
}

module.exports = { assertProfilePackages, profileExecutables, changeProfile };
