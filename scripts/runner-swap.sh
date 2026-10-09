#!/usr/bin/env bash

set -euo pipefail

readonly SWAP_BYTES=$((16 * 1024 * 1024 * 1024))
readonly MIN_FREE_KB=$((24 * 1024 * 1024))
readonly MIN_REMAINING_KB=$((8 * 1024 * 1024))
readonly OWNER_MARKER_CONTENT="paseo-fork-gradle-swap-v1"

fail() {
  printf '%s\n' "$1" >&2
  return 1
}

require_github_linux_context() {
  if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux || \
    "${GITHUB_REPOSITORY:-}" != iExalt/paseo || "${GITHUB_REF:-}" != refs/heads/dev || \
    "${GITHUB_ACTOR:-}" != iExalt ]]; then
    fail "Runner swap is restricted to the trusted Paseo GitHub Linux build."
  fi
}

runner_paths() {
  if [[ -z "${RUNNER_TEMP:-}" || "$RUNNER_TEMP" != /* || ! -d "$RUNNER_TEMP" || -L "$RUNNER_TEMP" ]]; then
    fail "RUNNER_TEMP must be an existing absolute directory."
  fi
  swap_file="$RUNNER_TEMP/paseo-fork-gradle.swap"
  owner_dir="$RUNNER_TEMP/paseo-fork-gradle-swap-owner"
  owner_marker="$owner_dir/owner"
}

available_kb() {
  local available
  available="$(df -Pk "$RUNNER_TEMP" | awk 'NR == 2 { print $4 }')"
  if [[ ! "$available" =~ ^[0-9]+$ ]]; then
    fail "Unable to measure free space on RUNNER_TEMP."
    return 1
  fi
  printf '%s\n' "$available"
}

is_swap_active() {
  local active
  active="$(swapon --noheadings --show=NAME --raw)" || {
    printf '%s\n' "Unable to verify active swap devices." >&2
    return 2
  }
  if grep -Fqx -- "$swap_file" <<<"$active"; then
    return 0
  fi
  return 1
}

cleanup_owned_swap() {
  if [[ ! -e "$owner_dir" && ! -L "$owner_dir" ]]; then
    return 0
  fi
  if [[ ! -d "$owner_dir" || -L "$owner_dir" || ! -f "$owner_marker" || -L "$owner_marker" ]] ||
    [[ "$(cat "$owner_marker")" != "$OWNER_MARKER_CONTENT" ]]; then
    fail "Task-owned swap marker is invalid; leaving runner files untouched."
    return 1
  fi

  if [[ -e "$swap_file" || -L "$swap_file" ]]; then
    if [[ ! -f "$swap_file" || -L "$swap_file" ]]; then
      fail "Task-owned swap path is not a regular file; leaving it untouched."
      return 1
    fi
    local swap_status=0
    if is_swap_active; then
      if ! sudo swapoff "$swap_file"; then
        fail "Could not disable task-owned swap; retaining its file."
        return 1
      fi
      if is_swap_active; then
        fail "Task-owned swap remains active; retaining its file."
        return 1
      else
        swap_status=$?
        if ((swap_status != 1)); then
          fail "Unable to verify task-owned swap state; retaining its file."
          return 1
        fi
      fi
    else
      swap_status=$?
      if ((swap_status != 1)); then
        fail "Unable to verify task-owned swap state; retaining its file."
        return 1
      fi
    fi
    rm -- "$swap_file"
  fi

  rm -- "$owner_marker"
  rmdir -- "$owner_dir"
}

enable_swap() {
  local free_before free_after owner_directory_created=0
  if [[ -e "$swap_file" || -L "$swap_file" || -e "$owner_dir" || -L "$owner_dir" ]]; then
    fail "Task-owned swap path already exists; refusing to alter it."
  fi

  free_before="$(available_kb)"
  if ((free_before < MIN_FREE_KB)); then
    fail "Fork APK build needs 24 GiB free before allocating its 16 GiB swapfile."
  fi

  if ! mkdir -m 700 -- "$owner_dir"; then
    fail "Unable to claim the task-owned swap marker path."
  fi
  owner_directory_created=1
  enable_failed_cleanup() {
    local original_status=$?
    trap - EXIT
    if ((original_status != 0)); then
      if [[ -f "$owner_marker" && ! -L "$owner_marker" ]]; then
        cleanup_owned_swap || true
      elif ((owner_directory_created)); then
        rmdir -- "$owner_dir" 2>/dev/null || true
      fi
    fi
    exit "$original_status"
  }
  trap enable_failed_cleanup EXIT

  umask 077
  printf '%s\n' "$OWNER_MARKER_CONTENT" >"$owner_marker"
  chmod 600 "$owner_marker"
  (set -o noclobber; : >"$swap_file")
  chmod 600 "$swap_file"
  fallocate -l "$SWAP_BYTES" "$swap_file"
  sudo mkswap "$swap_file" >/dev/null
  sudo swapon "$swap_file"
  if is_swap_active; then
    :
  else
    local swap_status=$?
    if ((swap_status == 2)); then
      fail "Unable to verify that the task-owned swapfile became active."
    fi
    fail "Task-owned swapfile did not become active."
  fi

  free_after="$(available_kb)"
  if ((free_after < MIN_REMAINING_KB)); then
    fail "Fork APK build must retain 8 GiB free after swap allocation."
  fi

  trap - EXIT
  printf 'runner_swap_enabled=true\n'
}

main() {
  local mode=${1:-}
  if [[ "$mode" != enable && "$mode" != cleanup ]]; then
    fail "Usage: runner-swap.sh enable|cleanup"
  fi
  require_github_linux_context
  runner_paths
  if [[ "$mode" == enable ]]; then
    enable_swap
  else
    cleanup_owned_swap
  fi
}

main "$@"
