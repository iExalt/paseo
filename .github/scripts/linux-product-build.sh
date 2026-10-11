#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$GITHUB_REPOSITORY" = iExalt/paseo
test "$GITHUB_REF" = refs/heads/dev
test "$GITHUB_ACTOR" = iExalt
case "$EXPECTED_ARCHITECTURE:$(uname -sm)" in
  x64:Linux\ x86_64|arm64:Linux\ aarch64) ;;
  *) exit 1 ;;
esac
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test -z "$(git status --porcelain)"
test ! -e /opt/Paseo
test ! -e /usr/bin/Paseo
for package in paseo Paseo; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then exit 1; fi
done
root="$RUNNER_TEMP/paseo-products-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
test ! -e "$root"
test -z "$(docker ps -aq --filter "name=^/paseo-products-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT$")"
mkdir -p "$root/evidence" "$root/state" "$root/packages" "$root/portable" "$root/mounts"
printf '%s\n' "$GITHUB_SHA" > "$root/owned"
if OWNED_SESSION_SKIP_XVFB=1 FIXTURE_FORMAT=ownership-probe TMPDIR="$root/evidence/mounts-ownership-probe" \
  node .github/scripts/linux-format-launch.mjs node -e '
    const {spawn}=require("node:child_process");
    spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}).unref();
    process.exit(1);
  ' > "$root/evidence/ownership-probe.log" 2>&1; then
  echo 'The monitor must reject an abnormal exit' >&2
  exit 1
fi
node --input-type=module -e '
  import assert from "node:assert/strict";
  import {readFileSync} from "node:fs";
  const receipt=JSON.parse(readFileSync(process.argv[1]));
  assert.equal(receipt.complete,true);
  assert.equal(receipt.result.code,1);
  assert.ok(receipt.owned.some((entry) => entry.session !== receipt.session));
  assert.deepEqual(receipt.remaining,[]);
  assert.deepEqual(receipt.mounts,[]);
' "$root/evidence/ownership-probe-cleanup.json"
sudo apt-get update -qq
sudo apt-get install -y rpm libfuse2t64 xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1
test -c /dev/fuse
previous=5619b7d7ee1e55b322028e8b7818aa1a8f752a0a
git worktree add --detach "$root/previous-source" "$previous"
for stage in candidate previous; do
  source="$GITHUB_WORKSPACE"
  if [ "$stage" = previous ]; then source="$root/previous-source"; fi
  started=$(date +%s)
  (
    cd "$source"
    timeout --kill-after=10s 180s npm ci --no-audit --no-fund
    timeout --kill-after=10s 600s npm run build:desktop -- --linux dir "--$EXPECTED_ARCHITECTURE" --publish never
  ) 2>&1 | tee "$root/evidence/$stage-build.log"
  printf '%s\n' "$(( $(date +%s) - started ))" > "$root/evidence/$stage-build-seconds.txt"
  node .github/scripts/linux-product-package.mjs "$source" "$stage" "$root" 2>&1 | tee "$root/evidence/$stage-packaging.log"
done
node .github/scripts/linux-product-stage.mjs manifest "$root"
