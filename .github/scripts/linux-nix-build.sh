#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_ACTIONS" = true
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$(uname -sm)" = 'Linux x86_64'
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test -z "$(git status --porcelain)"
command -v xvfb-run
command -v Xvfb
command -v xauth
directory=.dev/github-workflows/linux-nix
mkdir -p "$directory"
df -h / /nix
free -m
lscpu
nix config show | rg '^(cores|max-jobs|sandbox|builders|substituters) ='
# Record all derivation environments: individual builders may override Nix's
# per-build core budget. Sampling includes their combined memory/disk pressure.
nix derivation show .#paseo .#desktop > "$RUNNER_TEMP/linux-nix-derivations.json"
jq 'map_values(.env | with_entries(select(.key | test("(NIX|MAKE|JOBS|CORES|FLAGS)"))))' \
  "$RUNNER_TEMP/linux-nix-derivations.json" > "$directory/build-environment.json"
(
  while true; do
    date -u +%FT%TZ
    free -m
    df -BM /nix
    sleep 10
  done
) > "$directory/resources.log" &
monitor_pid=$!
trap 'kill "$monitor_pid" 2>/dev/null || true; wait "$monitor_pid" 2>/dev/null || true' EXIT
started=$(date +%s)
nix eval --raw --no-update-lock-file .#paseo.outPath > "$RUNNER_TEMP/linux-nix-daemon-path"
nix eval --raw --no-update-lock-file .#desktop.outPath > "$RUNNER_TEMP/linux-nix-desktop-path"
/usr/bin/time -v nix build --no-link --no-update-lock-file --json \
  --option max-jobs 2 --option cores 2 .#paseo .#desktop \
  > "$RUNNER_TEMP/linux-nix-outputs.json" 2> >(tee "$directory/build.log" >&2)
echo "Nix build elapsed: $(( $(date +%s) - started ))s" | tee -a "$GITHUB_STEP_SUMMARY"
test -z "$(git status --porcelain)"
