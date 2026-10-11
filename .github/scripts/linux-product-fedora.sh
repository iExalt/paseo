#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
export PATH="/node-bin:$PATH"
cd /repo
bash .github/scripts/linux-fedora-runtime-deps.sh "$EXPECTED_ARCHITECTURE"
useradd --create-home fixture
chown fixture:fixture /state /evidence
for stage in previous candidate; do
  artifact=$(node .github/scripts/linux-product-stage.mjs artifact /manifest.json "$stage" rpm /input)
  dnf -y install "$artifact"
  install -d -o fixture -g fixture -m 755 "/evidence/mounts-$stage"
  runuser -u fixture -- test -w "/evidence/mounts-$stage"
  OWNED_SESSION_UID="$(id -u fixture)" OWNED_SESSION_TIMEOUT_SECONDS=180 OWNED_SESSION_SKIP_XVFB=1 \
    FIXTURE_FORMAT="rpm-$stage" TMPDIR="/evidence/mounts-$stage" \
    bash -eu -c '
      grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status
      exec node /repo/.github/scripts/linux-format-launch.mjs runuser -u fixture -- node /repo/.github/scripts/linux-product-stage.mjs \
        "$1" rpm /manifest.json /state /evidence
    ' bash "$stage"
done
package=$(node .github/scripts/linux-product-stage.mjs package /manifest.json candidate rpm)
rpm -q --queryformat '[%{FILENAMES} %{FILEMODES:perms}\n]' "$package" > /evidence/rpm-owned-paths.txt
grep -q '^/opt/Paseo d' /evidence/rpm-owned-paths.txt
grep -q '^/opt/Paseo/resources d' /evidence/rpm-owned-paths.txt
dnf -y remove "$package"
if rpm -q "$package"; then exit 1; fi
bash /repo/.github/scripts/linux-rpm-uninstall-check.sh /opt/Paseo /usr/bin/Paseo /evidence/rpm-uninstall-paths.txt
printf 'RPM upgrade and uninstall passed\n' > /evidence/rpm-lifecycle.txt
