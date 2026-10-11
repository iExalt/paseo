#!/usr/bin/env bash
set -euo pipefail

test "$GITHUB_ACTIONS" = true
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$(uname -sm)" = 'Linux x86_64'
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test -z "$(git status --porcelain)"
started="$(date +%s)"
df -h / /nix
free -m
lscpu

# Evaluation must fail rather than silently compiling an import-from-derivation.
nix eval --json --no-update-lock-file --option allow-import-from-derivation false \
  --impure --expr '
  let
    flake = builtins.getFlake (toString ./.);
    pkgs = import flake.inputs.nixpkgs {
      system = "x86_64-linux";
      overlays = [(final: prev: import ./nix/runtime-overrides.nix { inherit final prev; })];
    };
    identity = package: {
      inherit (package) drvPath;
      outputs = builtins.listToAttrs (map (name: {
        inherit name; value = (builtins.getAttr name package).outPath;
      }) package.outputs);
    };
  in {
    node = identity pkgs.nodejs-slim_26;
    nodeWrapper = identity pkgs.nodejs_26;
    daemon = identity flake.packages.x86_64-linux.paseo;
    desktop = identity flake.packages.x86_64-linux.desktop;
  }' | tee "$RUNNER_TEMP/linux-package-plan.json" | jq .

# Reports required realizations/substitutions and their transfer/store sizes;
# --dry-run is mandatory: this canary must not build or install either product.
nix build --dry-run --no-link --no-update-lock-file \
  --option allow-import-from-derivation false .#paseo .#desktop
test -z "$(git status --porcelain)"
{
  echo "### Linux x64 dependency preflight"
  echo "Source: \`$GITHUB_SHA\`; evaluation only, no packages realized."
  echo "Elapsed: $(( $(date +%s) - started ))s; cores: $(nproc)."
  echo '```json'
  jq . "$RUNNER_TEMP/linux-package-plan.json"
  echo '```'
  df -h / /nix
} >> "$GITHUB_STEP_SUMMARY"
