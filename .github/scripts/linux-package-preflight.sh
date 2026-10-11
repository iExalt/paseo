#!/usr/bin/env bash
set -euo pipefail

test "$GITHUB_ACTIONS" = true
test "$RUNNER_ENVIRONMENT" = github-hosted
case "$EXPECTED_ARCHITECTURE:$(uname -sm)" in
  'x64:Linux x86_64') system=x86_64-linux ;;
  'arm64:Linux aarch64') system=aarch64-linux ;;
  *) echo 'Unexpected native preflight architecture' >&2; exit 1 ;;
esac
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
      system = builtins.currentSystem;
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
    daemon = identity flake.packages.${builtins.currentSystem}.paseo;
    desktop = identity flake.packages.${builtins.currentSystem}.desktop;
  }' | tee "$RUNNER_TEMP/linux-package-plan.json" | jq .

# Reports required realizations/substitutions and their transfer/store sizes;
# --dry-run is mandatory: this canary must not build or install either product.
nix build --dry-run --no-link --no-update-lock-file \
  --option allow-import-from-derivation false .#paseo .#desktop
test -z "$(git status --porcelain)"
{
  echo "### $system dependency preflight"
  echo "Source: \`$GITHUB_SHA\`; evaluation only, no packages realized."
  echo "Elapsed: $(( $(date +%s) - started ))s; cores: $(nproc)."
  echo '```json'
  jq . "$RUNNER_TEMP/linux-package-plan.json"
  echo '```'
  df -h / /nix
} >> "$GITHUB_STEP_SUMMARY"
