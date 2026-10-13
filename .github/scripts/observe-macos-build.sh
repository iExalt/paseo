#!/usr/bin/env bash
set -euo pipefail

log="$RUNNER_TEMP/paseo-macos-build-stderr.log"
test ! -e "$log"
: > "$log"
node .github/scripts/macos-build-observer.mjs "$log" "$$" &
observer=$!
cleanup() {
  local status=$?
  trap - EXIT
  kill -TERM "$observer" 2>/dev/null || true
  wait "$observer" || true
  exit "$status"
}
trap cleanup EXIT
# Keep the existing build command, stdout and exit status. The observer writes
# separately to stderr, so its output never resets the build-silence timer.
bash .github/scripts/nix-release-closure.sh build 2> >(tee "$log" >&2)
