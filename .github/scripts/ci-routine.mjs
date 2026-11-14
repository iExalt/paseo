  "scripts/release-manifest.test.mjs",
  "scripts/fork-release-config.test.mjs",
  ".github/scripts/release-mac-smoke-deps.test.mjs",
  ".github/scripts/release-mac-smoke.test.mjs",
  ".github/scripts/release-android-delta.test.mjs",
  "packages/desktop/scripts/after-pack.test.mjs",
  "scripts/paseo-nix-update-delta.test.mjs",
  "scripts/paseo-nix-update-semver.test.mjs",
  "scripts/nix-source-filter.test.mjs",
]; // Need built packages or Nix; run by hand, not by routine CI.
  if (selection.domains.includes("cli"))
    unit("cli", "test:unit", ["--exclude", "**/*.e2e.test.ts"]);
  // Four app workers starved live tests' 10 s hooks on 4-vCPU runners; three is the agreed response; watch for recurrence.
