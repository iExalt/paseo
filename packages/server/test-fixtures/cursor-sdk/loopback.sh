#!/usr/bin/env bash
set -euo pipefail

mode="${1:-green}"
target="${2:-$PWD}"
if [[ "$mode" != green && "$mode" != baseline ]]; then
  echo "Usage: bash loopback.sh [green|baseline] [built checkout] [Codex executable]" >&2
  exit 2
fi

fixture="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node="$(command -v node)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
cc -Wall -Wextra -Werror "$fixture/no-socket-proxy.c" -o "$scratch/no-socket-proxy"

trace() {
  local receipt="$1"
  shift
  # The shim applies Landlock and seccomp before exec, so every descendant can
  # connect only to ephemeral TCP ports. Tracing stops the processes only for
  # the socket syscalls checked by the receipt, and kills any survivors.
  env -i PATH=/usr/bin:/bin TMPDIR="$scratch" \
    /usr/bin/timeout --kill-after=3s 100s strace --seccomp-bpf --kill-on-exit -f -qq -s 64 \
    -e trace=connect,sendto,sendmsg,sendmmsg -o "$receipt" "$scratch/no-socket-proxy" "$@" </dev/null
}

trace "$scratch/preflight" --preflight
if "$node" "$fixture/check-egress.mjs" "$scratch/preflight" >"$scratch/preflight-check" 2>&1 ||
   ! grep -E 'Unexpected Internet destination.*192\.0\.2\.1' "$scratch/preflight-check" >/dev/null; then
  cat "$scratch/preflight-check" >&2
  echo "Fixture trace failed to detect the blocked external TCP attempt" >&2
  exit 1
fi

status=0
trace "$scratch/parity" "$node" "$fixture/parity.mjs" "$target" "$mode" "${3:-}" || status=$?
"$node" "$fixture/check-egress.mjs" "$scratch/parity"
exit "$status"
