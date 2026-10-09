#!/usr/bin/env bash

set -uo pipefail

interval_seconds=60
while (($#)); do
  case "$1" in
    --interval-seconds)
      if (($# < 2)) || [[ ! "$2" =~ ^[1-9][0-9]*$ ]] || ((10#$2 > 3600)); then
        echo "Expected --interval-seconds between 1 and 3600." >&2
        exit 2
      fi
      interval_seconds=$((10#$2))
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Expected optional --interval-seconds followed by -- COMMAND..." >&2
      exit 2
      ;;
  esac
done

if (($# == 0)); then
  echo "Expected a command after --." >&2
  exit 2
fi

child_pid=
sampler_pid=
sampler_sleep_pid=
sampler_stop_requested=0

resource_snapshot() {
  printf 'gradle_heartbeat_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if command -v free >/dev/null 2>&1; then
    free -b 2>/dev/null | awk 'NR == 2 { printf "memory_total_bytes=%s memory_used_bytes=%s memory_available_bytes=%s\n", $2, $3, $7 }' || true
  else
    printf 'memory_summary=unavailable\n'
  fi

  if ! df -Pk "${RUNNER_TEMP:-.}" . 2>/dev/null | awk 'NR == 1 || NR <= 3 { print "disk=" $0 }'; then
    printf 'disk_summary=unavailable\n'
  fi

  if [[ -r /sys/fs/cgroup/memory.events ]]; then
    if ! awk '$1 == "oom" || $1 == "oom_kill" || $1 == "oom_group_kill" { printf "cgroup_%s=%s\n", $1, $2 }' /sys/fs/cgroup/memory.events; then
      printf 'cgroup_oom_counters=unavailable\n'
    fi
  else
    printf 'cgroup_oom_counters=unavailable\n'
  fi

  if ! ps -Ao rss=,%cpu=,comm= 2>/dev/null | sort -nrk 1 | head -n 5 | awk 'NF >= 3 { name = $3; for (i = 4; i <= NF; i++) name = name " " $i; printf "top_process=%s rss_kb=%s cpu_pct=%s\n", name, $1, $2 }'; then
    printf 'process_summary=unavailable\n'
  fi
}

heartbeat_sampler() {
  trap 'sampler_stop_requested=1; if [[ -n "$sampler_sleep_pid" ]]; then kill "$sampler_sleep_pid" 2>/dev/null || true; fi' INT TERM

  while ((sampler_stop_requested == 0)); do
    sleep "$interval_seconds" &
    sampler_sleep_pid=$!
    if ((sampler_stop_requested)); then
      kill "$sampler_sleep_pid" 2>/dev/null || true
    fi
    wait "$sampler_sleep_pid" || true
    sampler_sleep_pid=
    if ((sampler_stop_requested == 0)); then
      resource_snapshot
    fi
  done
}

# These functions are invoked indirectly by the EXIT and signal traps below.
# shellcheck disable=SC2329
stop_sampler() {
  if [[ -z "$sampler_pid" ]]; then
    return
  fi

  kill -TERM "$sampler_pid" 2>/dev/null || true
  if wait "$sampler_pid"; then
    sampler_status=0
  else
    sampler_status=$?
  fi
  sampler_pid=
  printf 'gradle_heartbeat_sampler_exit_code=%s\n' "$sampler_status"
}

# shellcheck disable=SC2329
finish() {
  wrapper_status=$?
  trap - EXIT
  trap '' INT TERM
  stop_sampler
  printf 'gradle_wrapper_exit_code=%s\n' "$wrapper_status"
  exit "$wrapper_status"
}

# shellcheck disable=SC2329
forward_signal() {
  signal_name=$1
  if [[ "$signal_name" == TERM ]]; then
    fallback_status=143
  else
    fallback_status=130
  fi

  printf 'gradle_wrapper_signal=%s\n' "$signal_name"
  trap '' INT TERM
  if [[ -n "$child_pid" ]]; then
    kill -s "$signal_name" "$child_pid" 2>/dev/null || true
    if wait "$child_pid"; then
      child_status=0
    else
      child_status=$?
    fi
    child_pid=
    printf 'gradle_child_exit_code=%s\n' "$child_status"
    exit "$child_status"
  fi

  exit "$fallback_status"
}

trap finish EXIT
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

printf 'gradle_heartbeat_interval_seconds=%s\n' "$interval_seconds"
resource_snapshot
heartbeat_sampler &
sampler_pid=$!

"$@" &
child_pid=$!
if wait "$child_pid"; then
  child_status=0
else
  child_status=$?
fi
child_pid=
printf 'gradle_child_exit_code=%s\n' "$child_status"
exit "$child_status"
