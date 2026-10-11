#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
test -f /.dockerenv
architecture=${1:?native architecture required}
case "$architecture:$(uname -m)" in
  x64:x86_64|arm64:aarch64) ;;
  *) exit 1 ;;
esac
# The pinned host Node requires libatomic before even its version probe can run.
dnf -y install libatomic xorg-x11-server-Xvfb xorg-x11-xauth util-linux procps-ng mesa-libgbm
test "$(/node-bin/node --version)" = v26.11.0
test "$(/node-bin/node -p process.execPath)" = /node-bin/node
test "$(/node-bin/node -p process.arch)" = "$architecture"
/node-bin/node -p 'JSON.stringify({version:process.version,architecture:process.arch,executable:process.execPath})'
