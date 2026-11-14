#!/bin/sh
set -eu

# Resolve /usr/bin alternatives and user-created symlinks before finding Electron.
launcher=$(readlink -f -- "$0")
executable="${launcher}.bin"

if [ "${PASEO_APPIMAGE_SUPERVISOR:-}" = 1 ]; then
  if [ "${ELECTRON_RUN_AS_NODE:-}" != 1 ] || [ -z "${APPIMAGE:-}" ] ||
     [ ! -f "$APPIMAGE" ] || [ ! -x "$APPIMAGE" ] || [ -z "${APPDIR:-}" ] ||
     [ "$(readlink -f -- "$APPDIR")" != "$(dirname -- "$launcher")" ]; then
    echo 'Invalid AppImage supervisor context' >&2
    exit 1
  fi
  unset PASEO_APPIMAGE_SUPERVISOR
  if [ "${1:-}" = --no-sandbox ]; then shift; fi
  resources="$(dirname -- "$launcher")/resources"
  exec "$executable" --disable-warning=DEP0040 \
    "$resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js" node-script \
    "$resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js" "$@"
fi

# AppImage preserves the invoked symlink in ARGV0. The installed `paseo` link
# must enter Node before Chromium needs a display or writes startup logs.
invoked=${ARGV0:-}
if [ "${invoked##*/}" = paseo ] && [ -n "${APPIMAGE:-}" ] && [ -f "$APPIMAGE" ] &&
   [ -x "$APPIMAGE" ] && [ -n "${APPDIR:-}" ] &&
   [ "$(readlink -f -- "$APPDIR")" = "$(dirname -- "$launcher")" ]; then
  # AppRun reserves this leading browser flag, injecting it when userns fails.
  # The desktop passthrough also treats it as a launcher flag, not a CLI option.
  if [ "${1:-}" = --no-sandbox ]; then shift; fi
  exec "$(dirname -- "$launcher")/resources/bin/paseo" "$@"
fi

# Node entrypoints are not Chromium processes. Never inject browser flags here.
if [ "${ELECTRON_RUN_AS_NODE:-}" = 1 ]; then
  exec "$executable" "$@"
fi

for arg in "$@"; do
  if [ "$arg" = '--no-sandbox' ]; then
    export PASEO_DESKTOP_SANDBOX_REASON='requested by --no-sandbox'
    printf '[linux-sandbox] disabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
    exec "$executable" "$@"
  fi
done

# Match main's whitespace-separated debugging flags without evaluating shell code.
set -f
for flag in ${PASEO_ELECTRON_FLAGS:-}; do
  if [ "$flag" = '--no-sandbox' ]; then
    export PASEO_DESKTOP_SANDBOX_REASON='requested by PASEO_ELECTRON_FLAGS'
    printf '[linux-sandbox] disabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
    exec "$executable" --no-sandbox "$@"
  fi
done

# Map the real UID and create a network namespace as Chromium does. A bare
# unshare --user can succeed under AppArmor while namespace capabilities fail.
if namespace_error=$(unshare --user --map-root-user --net true 2>&1); then
  export PASEO_DESKTOP_SANDBOX_REASON='user namespaces available'
  printf '[linux-sandbox] enabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
  exec "$executable" "$@"
fi

helper="$(dirname -- "$launcher")/chrome-sandbox"
if [ -x "$helper" ] && [ "$(stat -Lc '%u:%a' -- "$helper")" = '0:4755' ] &&
   grep -q '^NoNewPrivs:[[:space:]]*0$' /proc/self/status; then
  mount_options=$(findmnt -n -o VFS-OPTIONS --target "$helper" 2>/dev/null || true)
  case ",$mount_options," in
    *,nosuid,*|,,) ;;
    *)
      export PASEO_DESKTOP_SANDBOX_REASON='root-owned SUID helper available'
      printf '[linux-sandbox] enabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
      exec "$executable" "$@"
      ;;
  esac
fi

export PASEO_DESKTOP_SANDBOX_REASON="user namespaces unavailable${namespace_error:+ ($namespace_error)}; no usable SUID helper"
printf '[linux-sandbox] disabled: %s\n' "$PASEO_DESKTOP_SANDBOX_REASON" >&2 || true
exec "$executable" --no-sandbox "$@"
