#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
case "$EXPECTED_ARCHITECTURE:$(uname -sm)" in
  'x64:Linux x86_64')
    electron_sha=20cafbe96e0ab8ad95cd31804acd683142b361f9e25f1595aecf67177d0a8915
    fedora='docker.io/library/fedora@sha256:be9d65e2344d805cc11114319c685ecaa96b6d9b4350a0a6460cdb931babbd19'
    ;;
  'arm64:Linux aarch64')
    electron_sha=9298bc6fb86528e79fbc643aaefe4e195e58153c40cddcfedec52a59ce114c79
    fedora='docker.io/library/fedora@sha256:e402cca673711fee025f9ce21c6c08b1bd25ee26b3c482119c8675fbaaedbc85'
    ;;
  *) echo 'Native architecture mismatch' >&2; exit 1 ;;
esac
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
test -z "$(git status --porcelain)"
test -c /dev/fuse
docker info >/dev/null
if dpkg-query -W -f='${Status}' paseo-format-fixture 2>/dev/null | grep -q 'install ok installed'; then
  echo 'Refusing to replace an existing fixture installation' >&2
  exit 1
fi
export FORMAT_ROOT="$RUNNER_TEMP/paseo-format-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
test ! -e "$FORMAT_ROOT"
mkdir -p "$FORMAT_ROOT/evidence" "$FORMAT_ROOT/payload" "$FORMAT_ROOT/home"
printf '%s\n' "$GITHUB_SHA" "$EXPECTED_ARCHITECTURE" "$fedora" > "$FORMAT_ROOT/evidence/identity.txt"
container="paseo-format-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
test -z "$(docker ps -aq --filter "name=^/$container$")"
touch "$FORMAT_ROOT/owned"
cleanup() {
  result=$?
  trap - EXIT
  bash "$GITHUB_WORKSPACE/.github/scripts/linux-format-cleanup.sh" || result=1
  exit "$result"
}
trap cleanup EXIT
sudo apt-get update -qq
sudo apt-get install -y libfuse2t64 xvfb xauth rpm libgtk-3-0t64 libnss3 libasound2t64 libgbm1
curl --fail --location --retry 2 --max-time 120 \
  "https://github.com/electron/electron/releases/download/v44.6.0/electron-v44.6.0-linux-$EXPECTED_ARCHITECTURE.zip" \
  --output "$FORMAT_ROOT/electron.zip"
printf '%s  %s\n' "$electron_sha" "$FORMAT_ROOT/electron.zip" | sha256sum --check
unzip -q "$FORMAT_ROOT/electron.zip" -d "$FORMAT_ROOT/payload"
node .github/scripts/linux-format-prepare.mjs
export ELECTRON_BUILDER_CACHE="$FORMAT_ROOT/builder-cache"
timeout --kill-after=10s 240s node node_modules/electron-builder/cli.js \
  --projectDir "$FORMAT_ROOT/project" --config "$FORMAT_ROOT/builder.json" \
  --prepackaged "$FORMAT_ROOT/payload" --linux deb rpm AppImage \
  "--$EXPECTED_ARCHITECTURE" --publish never 2>&1 | tee "$FORMAT_ROOT/evidence/build.log"
sha256sum "$FORMAT_ROOT/packages/"* > "$FORMAT_ROOT/evidence/packages.sha256"
test "$(dpkg-deb -f "$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.deb" Package)" = paseo-format-fixture
test "$(dpkg-deb -f "$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.deb" Version)" = 1.0.0
test "$(dpkg-deb -f "$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.deb" Architecture)" = "$(dpkg --print-architecture)"
test "$(rpm -qp --queryformat '%{NAME} %{VERSION} %{ARCH}' "$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.rpm")" = "paseo-format-fixture 1.0.0 $(uname -m)"
export FIXTURE_ARCH="$EXPECTED_ARCHITECTURE"
export FIXTURE_TOKEN="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_SHA"
run_fixture() {
  format=$1
  executable=$2
  FIXTURE_FORMAT="$format" FIXTURE_RECEIPT="$FORMAT_ROOT/evidence/$format.json" \
    HOME="$FORMAT_ROOT/home" TMPDIR="$FORMAT_ROOT/evidence/$format-mounts" \
    node .github/scripts/linux-format-launch.mjs "$executable" \
    --user-data-dir="$FORMAT_ROOT/$format-profile" > "$FORMAT_ROOT/evidence/$format.log" 2>&1
  FIXTURE_FORMAT="$format" node .github/scripts/linux-format-verify.mjs "$FORMAT_ROOT/evidence/$format.json"
}
export FIXTURE_APPIMAGE="$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.AppImage"
chmod +x "$FIXTURE_APPIMAGE"
run_fixture appimage "$FIXTURE_APPIMAGE"
sudo apt-get install -y "$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.deb"
test "$(stat -Lc '%u:%a' /opt/PaseoFormatFixture/chrome-sandbox)" = 0:4755
dpkg-query -W paseo-format-fixture
run_fixture deb /usr/bin/PaseoFormatFixture
sudo dpkg --purge paseo-format-fixture
test ! -e /opt/PaseoFormatFixture/chrome-sandbox
test ! -e /usr/bin/PaseoFormatFixture
printf 'DEB install, renderer, normal exit and uninstall passed\n' > "$FORMAT_ROOT/evidence/deb-lifecycle.txt"
mkdir "$FORMAT_ROOT/rpm-input"
cp "$FORMAT_ROOT/packages/fixture-$EXPECTED_ARCHITECTURE.rpm" "$FORMAT_ROOT/rpm-input/fixture.rpm"
# This directory is disposable and only the bounded container's nonroot user writes it.
chmod 777 "$FORMAT_ROOT/evidence"
timeout --kill-after=10s 300s docker run --name "$container" --cpus=2 --memory=4g --pids-limit=512 \
  --env FIXTURE_ARCH --env FIXTURE_TOKEN \
  --mount "type=bind,src=$FORMAT_ROOT/rpm-input,dst=/input,readonly" \
  --mount "type=bind,src=$FORMAT_ROOT/evidence,dst=/evidence" \
  --mount "type=bind,src=$GITHUB_WORKSPACE/.github/scripts,dst=/scripts,readonly" \
  "$fedora" bash /scripts/linux-format-fedora.sh > "$FORMAT_ROOT/evidence/fedora.log" 2>&1
docker inspect "$container" > "$FORMAT_ROOT/evidence/container.json"
docker rm "$container"
