#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_ACTIONS" = true
test "$RUNNER_ENVIRONMENT" = github-hosted
root="$RUNNER_TEMP/paseo-products-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
test -f "$root/owned" || exit 0
test "$(cat "$root/owned")" = "${PASEO_CANDIDATE_SHA:-$GITHUB_SHA}"
result=0
container="paseo-products-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
if [ -n "$(docker ps -aq --filter "name=^/$container$")" ]; then
  docker inspect "$container" > "$root/evidence/container-cleanup.json" || result=1
  docker rm -f "$container" || result=1
fi
if test -z "$(docker ps -aq --filter "name=^/$container$")"; then
  node "$GITHUB_WORKSPACE/.github/scripts/linux-product-state-cleanup.mjs" || result=1
else
  result=1
fi
for package in paseo Paseo; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    sudo dpkg --purge "$package" || result=1
  fi
done
test ! -e /opt/Paseo || result=1
test ! -e /usr/bin/Paseo || result=1
if [ -d "$root/previous-source" ]; then
  git worktree remove --force "$root/previous-source" || result=1
fi
exit "$result"
