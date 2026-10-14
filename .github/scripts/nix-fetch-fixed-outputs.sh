#!/usr/bin/env bash
# Realize the fixed-output derivations (npm-deps and other downloads) that the
# real build would have to build, retrying transient network failures. Their
# outputs are pinned by hash, so a retry cannot change bytes; without it one
# dropped connection fails a whole candidate attempt. Anything the configured
# substituters already serve is left to the build, which never fetches it.
# Usage: nix-fetch-fixed-outputs.sh [nix options...] -- <installable arguments...>
# Options apply to every nix command, matching the build that follows.
set -euo pipefail
options=()
while (( $# > 0 )) && [[ "$1" != -- ]]; do options+=("$1"); shift; done
(( $# > 1 )) || { echo 'Usage: [nix options...] -- <installables...>' >&2; exit 2; }
shift
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Bash 3.2 treats "${options[@]}" of an empty array as unbound under set -u.
nix_() { if (( ${#options[@]} > 0 )); then nix "$@" "${options[@]}"; else nix "$@"; fi; }
nix_ derivation show --recursive --no-update-lock-file "$@" > "$work/shown"
jq -r '(.derivations // .) | to_entries[]
  | select(any(.value.outputs[]; has("hash")))
  | if (.key | startswith("/")) then .key else "/nix/store/\(.key)" end' "$work/shown" \
  | sort -u > "$work/fixed"
# Nix prints the derivations it would build under a "will be built:" header.
nix_ build --dry-run --no-link --no-update-lock-file "$@" 2> "$work/plan"
awk '/will be built:$/ { section = 1; next } !/^  / { section = 0 }
  section && $1 ~ /^\/nix\/store\/.*\.drv$/ { print $1 }' "$work/plan" | sort -u > "$work/built"
fixed=()
while IFS= read -r derivation; do fixed+=("$derivation^*"); done < <(comm -12 "$work/fixed" "$work/built")
if ! grep -qE 'will be (built|fetched)' "$work/plan" && [[ -s "$work/fixed" ]]; then
  echo '::warning::nix build --dry-run printed no recognizable plan; prefetch skipped' >&2
fi
echo "Fixed-output derivations to fetch: ${#fixed[@]} of $(wc -l < "$work/fixed" | tr -d ' ')"
(( ${#fixed[@]} > 0 )) || exit 0
for attempt in 1 2 3; do
  if nix_ build --no-link "${fixed[@]}"; then exit 0; fi
  (( attempt < 3 )) || break
  echo "Fixed-output fetch attempt $attempt failed; retrying" >&2
  sleep $(( attempt * ${NIX_FETCH_RETRY_SECONDS:-20} ))
done
echo 'Fixed-output fetches failed after 3 attempts' >&2
exit 1
