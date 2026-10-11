#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$(uname -m)" = aarch64
if docker inspect paseo-native-candidate >/dev/null 2>&1; then
  echo 'Candidate container name already exists; refusing to adopt it.' >&2
  exit 1
fi
host_root=$(mktemp -d "${RUNNER_TEMP:?}/paseo-native-android.XXXXXX")
ashmem_loaded=0
cleanup() {
  local original=$? cleanup_failed=0
  docker logs --tail 60 paseo-native-candidate 2>&1 || true
  if docker inspect paseo-native-candidate >/dev/null 2>&1; then
    docker rm -f paseo-native-candidate >/dev/null || cleanup_failed=1
  fi
  if [[ "$ashmem_loaded" == 1 ]]; then sudo rmmod ashmem_linux || cleanup_failed=1; fi
  adb disconnect 127.0.0.1:5555 >/dev/null 2>&1 || true
  sudo rm -rf -- "$host_root" || cleanup_failed=1
  if (( cleanup_failed )); then exit 1; fi
  exit "$original"
}
trap cleanup EXIT

# Reuse Phase A's exact kernel module and ARM64 image pins on a disposable host.
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends "linux-modules-extra-$(uname -r)" "linux-headers-$(uname -r)" gcc-14 make adb apksigner aapt
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder
test ! -d /sys/module/ashmem_linux
grep -q '^CONFIG_KPROBES=y$' "/boot/config-$(uname -r)"
module_revision=f55e1e7515a6dd5f8e0f9569ea79148c08f60816
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-time 60 --max-filesize 10000000 \
  "https://codeload.github.com/remote-android/redroid-modules/tar.gz/$module_revision" -o "$host_root/modules.tar.gz"
echo "3bcc9c4084ddb8422e0865f648541f398569411c95f6de99b251f02e73b1776b  $host_root/modules.tar.gz" | sha256sum --check
tar -xzf "$host_root/modules.tar.gz" -C "$host_root" "redroid-modules-$module_revision/ashmem"
ashmem_source="$host_root/redroid-modules-$module_revision/ashmem"
timeout 120 make -C "/lib/modules/$(uname -r)/build" M="$ashmem_source" CC=gcc-14 -j2 modules
test "$(modinfo -F vermagic "$ashmem_source/ashmem_linux.ko" | cut -d ' ' -f1)" = "$(uname -r)"
sudo insmod "$ashmem_source/ashmem_linux.ko"
ashmem_loaded=1
test -c /dev/ashmem
image=redroid/redroid@sha256:e194edc99aa364358d1f8c214acb18b6d006c74fa0561f39259a20173ec30b66
timeout 180 docker pull --platform linux/arm64 "$image"
test "$(docker image inspect --format '{{.Architecture}}' "$image")" = arm64
mkdir "$host_root/data"
test ! -e "$RUNNER_TEMP/paseo-native-candidate-owned"
touch "$RUNNER_TEMP/paseo-native-candidate-owned"
docker run --detach --name paseo-native-candidate --privileged --platform linux/arm64 \
  --publish 127.0.0.1:5555:5555 --volume "$host_root/data:/data" "$image" \
  androidboot.use_memfd=1 androidboot.redroid_gpu_mode=guest \
  androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_fps=15
deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
  timeout 10 adb connect 127.0.0.1:5555 >/dev/null 2>&1 || true
  if [[ "$(timeout 10 adb -s 127.0.0.1:5555 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then break; fi
  sleep 5
done
test "$(timeout 10 adb -s 127.0.0.1:5555 shell getprop sys.boot_completed | tr -d '\r')" = 1
test "$(timeout 10 adb -s 127.0.0.1:5555 shell getprop ro.product.cpu.abilist | tr -d '\r')" = arm64-v8a
node .github/scripts/android-candidate-runtime.mjs
