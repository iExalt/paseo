#!/usr/bin/env bash
# Realize every fixed-output derivation (npm-deps and other downloads) behind
# the given installables before the real build, retrying transient network
# failures. Their outputs are pinned by hash, so a retry cannot change bytes;
# without it one dropped connection fails a whole candidate attempt.
# Usage: nix-fetch-fixed-outputs.sh <nix derivation show arguments...>
set -euo pipefail
(( $# > 0 )) || { echo 'Expected installables' >&2; exit 2; }
shown="$(mktemp)"
trap 'rm -f "$shown"' EXIT
nix derivation show --recursive --no-update-lock-file "$@" > "$shown"
fixed=()
while IFS= read -r derivation; do fixed+=("$derivation^*"); done < <(
  jq -r '(.derivations // .) | to_entries[]
    | select(any(.value.outputs[]; has("hash")))
    | if (.key | startswith("/")) then .key else "/nix/store/\(.key)" end' "$shown"
)
echo "Fixed-output derivations: ${#fixed[@]}"
(( ${#fixed[@]} > 0 )) || exit 0
for attempt in 1 2 3; do
  if nix build --no-link "${fixed[@]}"; then exit 0; fi
  (( attempt < 3 )) || break
  echo "Fixed-output fetch attempt $attempt failed; retrying" >&2
  sleep $(( attempt * ${NIX_FETCH_RETRY_SECONDS:-20} ))
done
echo 'Fixed-output fetches failed after 3 attempts' >&2
exit 1
