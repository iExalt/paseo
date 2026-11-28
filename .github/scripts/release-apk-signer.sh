#!/usr/bin/env bash
# Verify the APK and hash the verified signer certificate in DER form.
set -euo pipefail
apksigner="${1:?apksigner path required}"
apk="${2:?APK path required}"
expected="${3:?Expected certificate SHA-256 required}"
report="$("$apksigner" verify --verbose --print-certs-pem "$apk")"
if [[ "$(grep -cFx -- 'Number of signers: 1' <<< "$report")" != 1 \
   || "$(grep -cFx -- '-----BEGIN CERTIFICATE-----' <<< "$report")" != 1 ]]; then
  echo "::error::APK verification must report one signer and one certificate." >&2
  exit 1
fi
actual="$(openssl x509 -outform DER <<< "$report" | sha256sum | cut -d ' ' -f 1)"
if [[ "$actual" != "$expected" ]]; then
  echo "::error::Signed with $actual, expected $expected." >&2
  exit 1
fi
printf '%s\n' "$actual"
