#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_ACTIONS" = true
test "$RUNNER_ENVIRONMENT" = github-hosted
root="$RUNNER_TEMP/paseo-products-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
test "$(cat "$root/owned")" = "${PASEO_CANDIDATE_SHA:-$GITHUB_SHA}"
export OWNED_SESSION_TIMEOUT_SECONDS=180 OWNED_SESSION_SKIP_XVFB=1
container="paseo-products-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
finish() {
  local primary=$? cleanup=0
  trap - EXIT
  bash "$GITHUB_WORKSPACE/.github/scripts/linux-product-cleanup.sh" || cleanup=$?
  if [ "$primary" -ne 0 ]; then exit "$primary"; fi
  exit "$cleanup"
}
trap finish EXIT
node .github/scripts/linux-product-temp.mjs "$root" create
run_stage() {
  local format=$1 stage=$2 temporary
  temporary=$(node .github/scripts/linux-product-temp.mjs "$root" "$format-$stage")
  FIXTURE_FORMAT="$format-$stage" TMPDIR="$temporary" OWNED_SESSION_RECEIPT_DIRECTORY="$root/evidence" \
    node .github/scripts/linux-format-launch.mjs node .github/scripts/linux-product-stage.mjs \
      "$stage" "$format" "$root/manifest.json" "$root/state" "$root/evidence" \
      "$root/portable/Paseo-$EXPECTED_ARCHITECTURE.AppImage" \
      2>&1 | tee "$root/evidence/$format-$stage.log"
}
for stage in previous candidate; do
  artifact=$(node .github/scripts/linux-product-stage.mjs artifact "$root/manifest.json" "$stage" appimage "$root/packages")
  # Normal shutdown and the owned-session gate complete before replacing bytes.
  cp "$artifact" "$root/portable/Paseo-$EXPECTED_ARCHITECTURE.AppImage"
  chmod +x "$root/portable/Paseo-$EXPECTED_ARCHITECTURE.AppImage"
  run_stage appimage "$stage"
done
rm "$root/state/appimage/daemon/.local/bin/paseo" "$root/portable/Paseo-$EXPECTED_ARCHITECTURE.AppImage"
test ! -e "$root/portable/Paseo-$EXPECTED_ARCHITECTURE.AppImage"
printf 'Stable AppImage upgrade, retained CLI link and removal passed\n' > "$root/evidence/appimage-lifecycle.txt"
for stage in previous candidate; do
  artifact=$(node .github/scripts/linux-product-stage.mjs artifact "$root/manifest.json" "$stage" deb "$root/packages")
  sudo apt-get install -y "$artifact"
  run_stage deb "$stage"
done
package=$(node .github/scripts/linux-product-stage.mjs package "$root/manifest.json" candidate deb)
sudo dpkg --purge "$package"
test ! -e /opt/Paseo
test ! -e /usr/bin/Paseo
printf 'DEB upgrade and uninstall passed\n' > "$root/evidence/deb-lifecycle.txt"
case "$EXPECTED_ARCHITECTURE" in
  x64) fedora='docker.io/library/fedora@sha256:be9d65e2344d805cc11114319c685ecaa96b6d9b4350a0a6460cdb931babbd19' ;;
  arm64) fedora='docker.io/library/fedora@sha256:e402cca673711fee025f9ce21c6c08b1bd25ee26b3c482119c8675fbaaedbc85' ;;
  *) exit 1 ;;
esac
mkdir "$root/rpm-state" "$root/evidence/rpm"
chmod 777 "$root/rpm-state" "$root/evidence/rpm"
timeout --kill-after=10s 300s docker run --name "$container" --cpus=2 --memory=4g --pids-limit=512 \
  --security-opt=no-new-privileges --env GITHUB_SHA --env PASEO_CANDIDATE_SHA --env EXPECTED_ARCHITECTURE \
  --mount "type=bind,src=$GITHUB_WORKSPACE,dst=/repo,readonly" \
  --mount "type=bind,src=$(dirname "$(mise which node)"),dst=/node-bin,readonly" \
  --mount "type=bind,src=$root/packages,dst=/input,readonly" \
  --mount "type=bind,src=$root/manifest.json,dst=/manifest.json,readonly" \
  --mount "type=bind,src=$root/rpm-state,dst=/state" \
  --mount "type=bind,src=$root/evidence/rpm,dst=/evidence" \
  "$fedora" bash /repo/.github/scripts/linux-product-fedora.sh \
  2>&1 | tee "$root/evidence/fedora.log"
docker inspect "$container" > "$root/evidence/container.json"
docker rm "$container"
