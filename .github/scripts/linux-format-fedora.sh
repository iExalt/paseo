#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
case "$FIXTURE_ARCH:$(uname -m)" in
  x64:x86_64|arm64:aarch64) ;;
  *) exit 1 ;;
esac
dnf -y install /input/fixture.rpm nodejs xorg-x11-server-Xvfb xorg-x11-xauth util-linux procps-ng mesa-libgbm
useradd --create-home fixture
test "$(stat -Lc '%u:%a' /opt/PaseoFormatFixture/chrome-sandbox)" = 0:4755
rpm -q paseo-format-fixture
runuser -u fixture -- env FIXTURE_RECEIPT=/evidence/rpm.json FIXTURE_FORMAT=rpm TMPDIR=/evidence/rpm-mounts \
  bash -eu -c '
    grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status
    exec node /scripts/linux-format-launch.mjs /usr/bin/PaseoFormatFixture \
      --user-data-dir=/home/fixture/profile
  '
FIXTURE_FORMAT=rpm node /scripts/linux-format-verify.mjs /evidence/rpm.json
dnf -y remove paseo-format-fixture
if rpm -q paseo-format-fixture; then exit 1; fi
test ! -e /opt/PaseoFormatFixture/chrome-sandbox
test ! -e /usr/bin/PaseoFormatFixture
printf 'RPM install, renderer, normal exit and uninstall passed\n' > /evidence/rpm-lifecycle.txt
