#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
case "$FIXTURE_ARCH:$(uname -m)" in
  x64:x86_64|arm64:aarch64) ;;
  *) exit 1 ;;
esac
export PATH="/node-bin:$PATH"
bash /scripts/linux-fedora-runtime-deps.sh "$FIXTURE_ARCH"
rpm -qp --scripts /input/legacy.rpm > /evidence/rpm-legacy-scripts.txt
rpm -qp --scripts /input/fixture.rpm > /evidence/rpm-candidate-scripts.txt
if grep -q 'posttrans\|remaining-package count' /evidence/rpm-legacy-scripts.txt; then exit 1; fi
grep -q 'posttrans' /evidence/rpm-candidate-scripts.txt
grep -q 'remaining-package count' /evidence/rpm-candidate-scripts.txt
dnf -y install /input/legacy.rpm
test "$(rpm -q --queryformat '%{VERSION}' paseo-format-fixture)" = 0.9.0
test "$(readlink -f /usr/bin/PaseoFormatFixture)" = /opt/PaseoFormatFixture/PaseoFormatFixture
dnf -y install /input/fixture.rpm
test "$(rpm -q --queryformat '%{VERSION}' paseo-format-fixture)" = 1.0.0
test "$(readlink -f /usr/bin/PaseoFormatFixture)" = /opt/PaseoFormatFixture/PaseoFormatFixture
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
rpm -q --queryformat '[%{FILENAMES} %{FILEMODES:perms}\n]' paseo-format-fixture > /evidence/rpm-owned-paths.txt
grep -q '^/opt/PaseoFormatFixture d' /evidence/rpm-owned-paths.txt
grep -q '^/opt/PaseoFormatFixture/resources d' /evidence/rpm-owned-paths.txt
dnf -y remove paseo-format-fixture
if rpm -q paseo-format-fixture; then exit 1; fi
bash /scripts/linux-rpm-uninstall-check.sh /opt/PaseoFormatFixture /usr/bin/PaseoFormatFixture /evidence/rpm-uninstall-paths.txt
printf 'RPM legacy upgrade, renderer, normal exit and uninstall passed\n' > /evidence/rpm-lifecycle.txt
