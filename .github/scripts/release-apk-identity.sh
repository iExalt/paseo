#!/usr/bin/env bash
# Asserts the fork APK identity clients rely on: package, version, release
# build, the arm64-v8a-only native ABI and no build-host IP.
# Usage: release-apk-identity.sh <apk>; reads VERSION, PASEO_ANDROID_VERSION_CODE, ANDROID_HOME.
set -euo pipefail
apk="${1:?APK path required}"
analyzer="${ANDROID_HOME:?}/cmdline-tools/latest/bin/apkanalyzer"
check() {
  local actual
  actual="$("$analyzer" manifest "$1" "$apk")"
  [[ "$actual" == "$2" ]] || { echo "::error::APK $1 is $actual, expected $2." >&2; exit 1; }
}
[[ "$(stat -c%s "$apk")" -le 536870912 ]] || { echo "::error::APK exceeds 512 MiB." >&2; exit 1; }
check application-id sh.paseo.iexalt
check version-code "${PASEO_ANDROID_VERSION_CODE:?}"
check version-name "${VERSION:?}"
check debuggable false
abis="$(unzip -Z1 "$apk" | awk -F/ '$1 == "lib" && NF >= 3 { print $2 }' | sort -u)"
[[ "$abis" == arm64-v8a ]] || { echo "::error::APK native ABIs are: $abis" >&2; exit 1; }
# React Native's Gradle plugin bakes the build host's IP in unless release.yml
# sets reactNativeDevServerIp; apkanalyzer prints nothing for a missing resource.
dev_server_ip="$("$analyzer" resources value --config default --name react_native_dev_server_ip --type string "$apk")"
[[ "$dev_server_ip" == localhost ]] \
  || { echo "::error::APK react_native_dev_server_ip is '$dev_server_ip', expected localhost." >&2; exit 1; }
echo "APK identity verified: sh.paseo.iexalt $VERSION ($PASEO_ANDROID_VERSION_CODE), arm64-v8a only."
