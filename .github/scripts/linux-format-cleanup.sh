#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
root="$RUNNER_TEMP/paseo-format-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
test -f "$root/owned" || exit 0
container="paseo-format-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
ids=$(docker ps -aq --filter "name=^/$container$")
if [ -n "$ids" ]; then
  test "$(docker inspect --format '{{.Name}}' "$container")" = "/$container"
  docker rm -f "$container"
fi
test -z "$(docker ps -aq --filter "name=^/$container$")"
if dpkg-query -W -f='${Status}' paseo-format-fixture 2>/dev/null | grep -q 'install ok installed'; then
  sudo dpkg --purge paseo-format-fixture
fi
test ! -e /opt/PaseoFormatFixture/chrome-sandbox
test ! -e /usr/bin/PaseoFormatFixture
