#!/usr/bin/env bash
# Installs an APK over a slow or flaky adb link: pushes it gzipped in 4 MiB chunks, each
# retried on its own, then inflates and hash-checks it on the device. A debug APK stores
# its dex, .so and JS uncompressed, so this sends about a third of the bytes.
#   scripts/adb-gz-install.sh SERIAL APK|APK.gz [SHA256]
# SHA256 is of the uncompressed APK; it defaults to the local APK's hash and is required
# when you pass a .gz.
set -euo pipefail
(($# >= 2 && $# <= 3)) || { echo "usage: $0 SERIAL APK|APK.gz [SHA256]" >&2; exit 2; }
serial=$1
source_file=$2
expected=${3:-}
adb_cmd=(adb -s "$serial")
remote=/data/local/tmp/paseo-gz-install
work=$(mktemp -d)
trap 'rm -rf "$work"; "${adb_cmd[@]}" shell rm -rf "$remote" > /dev/null 2>&1 || true' EXIT

if [[ $source_file == *.gz ]]; then
  gz=$source_file
else
  gz=$work/app.apk.gz
  gzip -9 -n -c "$source_file" > "$gz"
  [[ -n $expected ]] || expected=$(shasum -a 256 "$source_file" | cut -d' ' -f1)
fi
expected=$(tr '[:upper:]' '[:lower:]' <<< "$expected")
[[ $expected =~ ^[0-9a-f]{64}$ ]] || { echo "Pass the SHA256 of the uncompressed APK." >&2; exit 2; }

split -b 4194304 -a 4 "$gz" "$work/chunk."
chunks=("$work"/chunk.*)
"${adb_cmd[@]}" shell "rm -rf $remote && mkdir -p $remote"
for index in "${!chunks[@]}"; do
  for attempt in 1 2 3 4 5; do
    "${adb_cmd[@]}" push "${chunks[index]}" "$remote/" > /dev/null && break
    ((attempt < 5)) || { echo "Pushing ${chunks[index]##*/} failed." >&2; exit 1; }
    sleep 2
  done
  echo "Pushed $((index + 1))/${#chunks[@]}"
done

# toybox expands the glob in name order, which is split's order.
"${adb_cmd[@]}" shell "cat $remote/chunk.* | gunzip > $remote/app.apk && rm $remote/chunk.*"
actual=$("${adb_cmd[@]}" shell sha256sum "$remote/app.apk" | cut -d' ' -f1 | tr -d '\r')
[[ $actual == "$expected" ]] || { echo "Device APK hash $actual, expected $expected." >&2; exit 1; }
"${adb_cmd[@]}" shell pm install -r "$remote/app.apk"
