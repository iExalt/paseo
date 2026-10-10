#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$(uname -m)" = aarch64
probe_dir=$(mktemp -d "${RUNNER_TEMP:?}/paseo-arm64.XXXXXX")
cleanup() {
  timeout 10 adb -s 127.0.0.1:5555 logcat -d -b crash -t 100 2>&1 || true
  docker logs --tail 60 paseo-arm64-probe 2>&1 || true
  docker rm -f paseo-arm64-probe >/dev/null 2>&1 || true
  adb disconnect 127.0.0.1:5555 >/dev/null 2>&1 || true
  sudo rm -rf -- "$probe_dir"
}
trap cleanup EXIT

# Disposable GitHub host only; never a developer machine or physical device.
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends "linux-modules-extra-$(uname -r)" adb apksigner aapt
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder

release_base=https://github.com/iExalt/paseo/releases/download/paseo-fork-v0.11.0-r200008-5619b7d7ee1e55b322028e8b7818aa1a8f752a0a
for asset in paseo-release-manifest.json paseo-release-manifest.sig paseo-android-arm64.apk; do
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --max-time 120 --max-filesize 150000000 "$release_base/$asset" -o "$probe_dir/$asset"
done
node .github/scripts/verify-probe-apk.mjs "$probe_dir"

# ARM64 manifest resolved from redroid/redroid:16.0.0_64only-latest, never a floating tag.
probe_image=redroid/redroid@sha256:e194edc99aa364358d1f8c214acb18b6d006c74fa0561f39259a20173ec30b66
timeout 180 docker pull --platform linux/arm64 "$probe_image"
test "$(docker image inspect --format '{{.Architecture}}' "$probe_image")" = arm64
mkdir "$probe_dir/data"
docker run --detach --name paseo-arm64-probe --privileged --platform linux/arm64 \
  --publish 127.0.0.1:5555:5555 --volume "$probe_dir/data:/data" "$probe_image" \
  androidboot.use_memfd=1 androidboot.redroid_gpu_mode=guest \
  androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_fps=15

boot_deadline=$((SECONDS + 300))
while (( SECONDS < boot_deadline )); do
  timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1 || true
  if [[ "$(timeout 10 adb -s 127.0.0.1:5555 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then break; fi
  sleep 5
done
test "$(timeout 10 adb -s 127.0.0.1:5555 shell getprop sys.boot_completed | tr -d '\r')" = 1
android() { timeout 30 adb -s 127.0.0.1:5555 "$@"; }
test "$(android shell getprop ro.product.cpu.abi | tr -d '\r')" = arm64-v8a
test "$(android shell getprop ro.product.cpu.abilist | tr -d '\r')" = arm64-v8a
timeout 90 adb -s 127.0.0.1:5555 install "$probe_dir/paseo-android-arm64.apk"
android shell dumpsys package sh.paseo.iexalt > "$probe_dir/package.txt"
grep -q 'primaryCpuAbi=arm64-v8a' "$probe_dir/package.txt"
activity=$(android shell cmd package resolve-activity --brief sh.paseo.iexalt | tr -d '\r' | tail -1)
[[ "$activity" == sh.paseo.iexalt/* ]]
android logcat -c
android shell am start -W -n "$activity"
probe_pid=$(android shell pidof sh.paseo.iexalt | tr -d '\r')
test -n "$probe_pid"
for observation in 1 2 3 4 5 6; do
  sleep 5
  test "$(android shell pidof sh.paseo.iexalt | tr -d '\r')" = "$probe_pid"
  android shell dumpsys activity activities > "$probe_dir/activities.txt"
  grep -E '(mResumedActivity|topResumedActivity).*sh\.paseo\.iexalt/' "$probe_dir/activities.txt"
done
android logcat -d -b crash > "$probe_dir/crashes.txt"
cat "$probe_dir/crashes.txt"
if grep -q 'sh.paseo.iexalt' "$probe_dir/crashes.txt"; then exit 1; fi
echo 'PASS: native ARM64 Android boot, signed APK install and sustained foreground app process (30 seconds).'
