#!/usr/bin/env bash
# Builds, signs and exports the macOS Nix desktop closure for release.yml.
#   build:  build the desktop output (dependencies from cache.nixos.org), write the closure manifest
#   export: sign the closure with the Nix release key and pack a file:// binary cache as plain ustar
# Inputs: VERSION, SOURCE_SHA, RUNNER_TEMP, GITHUB_OUTPUT;
# NIX_RELEASE_SIGNING_KEY for export only.
set -euo pipefail
export LC_ALL=C

readonly desktop_attr=".#packages.aarch64-darwin.desktop"
readonly release_public_key="paseo-nix-release-1:hOc4RkmgnDMh/+aZWDdwQKuZHDVvVPh0Fya+DNAA+b8="
readonly out_dir="$RUNNER_TEMP/paseo-release-macos"
readonly state_file="$RUNNER_TEMP/paseo-release-macos-output-path"

fail() {
  echo "::error::$*" >&2
  exit 1
}

check_source() {
  [[ "${VERSION:?}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unexpected version $VERSION."
  [[ "$(git rev-parse HEAD)" == "${SOURCE_SHA:?}" ]] || fail "Checkout differs from the source SHA."
  [[ -z "$(git status --porcelain)" ]] || fail "The checkout is not clean."
  [[ "$(jq -er .version package.json)" == "$VERSION" ]] || fail "package.json version differs."
  [[ "$(nix --version)" == "nix (Nix) 2.34.7" ]] || fail "Expected Nix 2.34.7."
  [[ "$(uname -m)" == arm64 ]] || fail "Expected an arm64 runner."
}

build() {
  local output_path closure_json manifest_file
  check_source
  # Retries transient download failures of fixed-output derivations.
  bash .github/scripts/nix-fetch-fixed-outputs.sh --option builders '' -- "$desktop_attr"
  # Node must come from cache.nixos.org; building it from source takes hours.
  if nix build --dry-run --no-link --no-update-lock-file --option builders '' "$desktop_attr" 2>&1 \
    | awk '/will be built:$/ { section = 1; next } !/^  / { section = 0 } section' \
    | grep -E -- '-nodejs(-slim)?-[0-9]'; then
    fail "Node is not substitutable from cache.nixos.org for this flake.lock."
  fi
  output_path="$(nix build -L --no-link --print-out-paths --no-update-lock-file \
    --option builders '' "$desktop_attr")"
  [[ "$output_path" =~ ^/nix/store/[a-z0-9]{32}-paseo-desktop-${VERSION//./\\.}$ ]] \
    || fail "Unexpected desktop output path $output_path."

  mkdir -p "$out_dir"
  manifest_file="$out_dir/paseo-$VERSION-macos-arm64-nix-desktop.json"
  closure_json="$(nix path-info --json --recursive "$output_path" \
    | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  # Fields read by validateNixArtifactClosure in scripts/paseo-nix-update.mjs.
  jq -nS \
    --arg sourceSha "$SOURCE_SHA" --arg forkVersion "$VERSION" \
    --arg lockHash "$(shasum -a 256 flake.lock | awk '{print $1}')" --arg outputPath "$output_path" \
    --argjson closure "$closure_json" \
    '{kind: "paseo-verification-candidate", schemaVersion: 2, platform: "macos-arm64",
      sourceSha: $sourceSha, forkVersion: $forkVersion, packageVersion: $forkVersion,
      lockHash: $lockHash, system: "aarch64-darwin", attr: ".#packages.aarch64-darwin.desktop",
      outputPath: $outputPath, provenance: "local-ci-build", closure: $closure}' \
    > "$manifest_file"
  printf '%s\n' "$output_path" > "$state_file"
  printf 'output_path=%s\n' "$output_path" >> "$GITHUB_OUTPUT"
}

export_closure() {
  local output_path key_file cache_dir archive
  check_source
  output_path="$(cat "$state_file")"
  key_file="$RUNNER_TEMP/paseo-nix-release-secret-key"
  cache_dir="$RUNNER_TEMP/paseo-nix-release-cache"
  archive="$out_dir/paseo-$VERSION-macos-arm64-nix-desktop.tar"
  [[ -n "${NIX_RELEASE_SIGNING_KEY:-}" ]] || fail "The Nix release signing key is unavailable."
  trap 'rm -f "$RUNNER_TEMP/paseo-nix-release-secret-key"' EXIT
  (umask 077 && printf '%s\n' "$NIX_RELEASE_SIGNING_KEY" > "$key_file")
  unset NIX_RELEASE_SIGNING_KEY
  [[ "$(nix key convert-secret-to-public < "$key_file")" == "$release_public_key" ]] \
    || fail "The Nix signing key does not match the pinned release public key."
  # Store paths keep only their original cache signatures; sign every path so a
  # fresh store can verify the closure with the release key alone.
  nix store sign --key-file "$key_file" --recursive "$output_path"
  nix copy --to "file://$cache_dir?secret-key=$key_file" --option builders '' "$output_path"
  rm -f "$key_file"
  trap - EXIT
  # The client's extractor accepts plain ustar only: no AppleDouble members.
  COPYFILE_DISABLE=1 tar --format ustar -cf "$archive" -C "$cache_dir" .
  rm -rf "$cache_dir"
  ls -l "$out_dir"
}

case "${1:-}" in
  build) build ;;
  export) export_closure ;;
  *) fail "Usage: $0 {build|export}" ;;
esac
