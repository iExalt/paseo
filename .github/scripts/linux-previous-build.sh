#!/usr/bin/env bash
set -euo pipefail
previous_sha=b6e0474aec58b2c169f61b81b20de890d4138e30
previous_root="$RUNNER_TEMP/paseo-linux-predecessor"
test ! -e "$previous_root"
git worktree add --detach "$previous_root" "$previous_sha"
trap 'git worktree remove --force "$previous_root"' EXIT
test "$(git -C "$previous_root" rev-parse HEAD)" = "$previous_sha"
test -z "$(git -C "$previous_root" status --porcelain)"
export PREVIOUS_FLAKE="git+file://$previous_root?rev=$previous_sha"
expression='import ./.github/scripts/linux-previous-packages.nix { source = builtins.getEnv "PREVIOUS_FLAKE"; }'
directory=.dev/github-workflows/linux-nix
cp .github/scripts/linux-previous-packages.nix "$directory/predecessor-override.nix"
sha256sum .github/scripts/linux-previous-packages.nix > "$directory/predecessor-override.sha256"
echo "$previous_sha" > "$directory/predecessor-source.txt"
for package in daemon desktop; do
  nix eval --impure --raw --no-update-lock-file --expr "($expression).$package.outPath" \
    > "$RUNNER_TEMP/linux-nix-previous-$package-path"
done
for package in daemon desktop; do
  bash .github/scripts/nix-fetch-fixed-outputs.sh --option max-jobs 2 --option cores 2 \
    -- --impure --expr "($expression).$package"
done
started=$(date +%s)
nix build --impure --no-link --no-update-lock-file --json \
  --option max-jobs 2 --option cores 2 \
  --expr "let packages = $expression; in [ packages.daemon packages.desktop ]" \
  > "$RUNNER_TEMP/linux-nix-previous-outputs.json"
jq -r '.[].drvPath' "$RUNNER_TEMP/linux-nix-previous-outputs.json" | while read -r derivation; do
  nix log "$derivation" > "$directory/$(basename "$derivation").log"
done
echo "Predecessor build elapsed: $(( $(date +%s) - started ))s" >> "$GITHUB_STEP_SUMMARY"
