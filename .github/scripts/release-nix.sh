#!/usr/bin/env bash
# Builds, signs and exports a release Nix closure for release.yml: the desktop
# on macOS, the CLI/daemon and desktop on Linux. The runner picks the platform.
#   build:  build the outputs (dependencies from cache.nixos.org), write the closure manifest
#   export: sign the closure with the Nix release key and pack a zstd file:// binary cache as plain ustar
#   (on macOS, release-mac-index.mjs then writes the unsigned index and delta sidecars)
# Inputs: VERSION, SOURCE_SHA, RUNNER_TEMP, GITHUB_OUTPUT;
# NIX_RELEASE_SIGNING_KEY for export only.
set -euo pipefail
export LC_ALL=C

readonly release_public_key="paseo-nix-release-1:hOc4RkmgnDMh/+aZWDdwQKuZHDVvVPh0Fya+DNAA+b8="

fail() {
  echo "::error::$*" >&2
  exit 1
}

# Only the macOS asset names are part of the signed manifest's contract; the
# Linux ones sit beside it unsigned, and Nix checks their paths' signatures.
case "$(uname -sm)" in
  "Darwin arm64") platform=macos-arm64 system=aarch64-darwin attrs=(desktop) suffix=nix-desktop ;;
  "Linux x86_64") platform=linux-x64 system=x86_64-linux attrs=(paseo desktop) suffix=nix ;;
  "Linux aarch64") platform=linux-arm64 system=aarch64-linux attrs=(paseo desktop) suffix=nix ;;
  *) fail "Unexpected runner $(uname -sm)." ;;
esac
readonly platform system attrs suffix
readonly out_dir="$RUNNER_TEMP/paseo-release-${platform%%-*}"
readonly state_file="$RUNNER_TEMP/paseo-release-$platform-output-paths"
installables=()
for attr in "${attrs[@]}"; do installables+=(".#packages.$system.$attr"); done
readonly installables

check_source() {
  [[ "${VERSION:?}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unexpected version $VERSION."
  [[ "$(git rev-parse HEAD)" == "${SOURCE_SHA:?}" ]] || fail "Checkout differs from the source SHA."
  [[ -z "$(git status --porcelain)" ]] || fail "The checkout is not clean."
  [[ "$(jq -er .version package.json)" == "$VERSION" ]] || fail "package.json version differs."
  [[ "$(nix --version)" == "nix (Nix) 2.34.7" ]] || fail "Expected Nix 2.34.7."
}

build() {
  local attr output_path output_paths closure_json manifest_file
  check_source
  # Retries transient download failures of fixed-output derivations.
  bash .github/scripts/nix-fetch-fixed-outputs.sh --option builders '' -- "${installables[@]}"
  # Node must come from cache.nixos.org; building it from source takes hours.
  if nix build --dry-run --no-link --no-update-lock-file --option builders '' "${installables[@]}" 2>&1 \
    | awk '/will be built:$/ { section = 1; next } !/^  / { section = 0 } section' \
    | grep -E -- '-nodejs(-slim)?-[0-9]'; then
    fail "Node is not substitutable from cache.nixos.org for this flake.lock."
  fi
  output_paths=()
  for attr in "${installables[@]}"; do
    output_path="$(nix build -L --no-link --print-out-paths --no-update-lock-file \
      --option builders '' "$attr")"
    [[ "$output_path" =~ ^/nix/store/[a-z0-9]{32}-paseo(-desktop)?-${VERSION//./\\.}$ ]] \
      || fail "Unexpected output path $output_path for $attr."
    output_paths+=("$output_path")
  done
  # The desktop is always the last attribute.
  output_path="${output_paths[${#output_paths[@]} - 1]}"
  [[ "$output_path" == *-paseo-desktop-"$VERSION" ]] || fail "Unexpected desktop output path $output_path."

  mkdir -p "$out_dir"
  manifest_file="$out_dir/paseo-$VERSION-$platform-$suffix.json"
  closure_json="$(nix path-info --json --recursive "${output_paths[@]}" \
    | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  # Fields read by validateNixArtifactClosure in scripts/paseo-nix-update.mjs;
  # outputPaths lists every installable in attribute order.
  jq -nS \
    --arg sourceSha "$SOURCE_SHA" --arg forkVersion "$VERSION" \
    --arg lockHash "$(shasum -a 256 flake.lock | awk '{print $1}')" --arg outputPath "$output_path" \
    --arg platform "$platform" --arg system "$system" --arg attr "${installables[${#installables[@]} - 1]}" \
    --argjson outputPaths "$(printf '%s\n' "${output_paths[@]}" | jq -R . | jq -cs .)" \
    --argjson closure "$closure_json" \
    '{kind: "paseo-verification-candidate", schemaVersion: 2, platform: $platform,
      sourceSha: $sourceSha, forkVersion: $forkVersion, packageVersion: $forkVersion,
      lockHash: $lockHash, system: $system, attr: $attr,
      outputPath: $outputPath, provenance: "local-ci-build", closure: $closure}
     + if $platform == "macos-arm64" then {} else {outputPaths: $outputPaths} end' \
    > "$manifest_file"
  printf '%s\n' "${output_paths[@]}" > "$state_file"
  printf 'output_path=%s\n' "$output_path" >> "$GITHUB_OUTPUT"
}

export_closure() {
  local line output_paths key_file cache_dir archive
  check_source
  output_paths=()
  while IFS= read -r line; do output_paths+=("$line"); done < "$state_file"
  key_file="$RUNNER_TEMP/paseo-nix-release-secret-key"
  cache_dir="$RUNNER_TEMP/paseo-nix-release-cache"
  archive="$out_dir/paseo-$VERSION-$platform-$suffix.tar"
  [[ -n "${NIX_RELEASE_SIGNING_KEY:-}" ]] || fail "The Nix release signing key is unavailable."
  trap 'rm -f "$RUNNER_TEMP/paseo-nix-release-secret-key"' EXIT
  (umask 077 && printf '%s\n' "$NIX_RELEASE_SIGNING_KEY" > "$key_file")
  unset NIX_RELEASE_SIGNING_KEY
  [[ "$(nix key convert-secret-to-public < "$key_file")" == "$release_public_key" ]] \
    || fail "The Nix signing key does not match the pinned release public key."
  # Store paths keep only their original cache signatures; sign every path so a
  # fresh store can verify the closure with the release key alone.
  nix store sign --key-file "$key_file" --recursive "${output_paths[@]}"
  # zstd instead of the default xz: xz took most of the ~280 s export. The
  # installing host's nix decompresses; the client's extractor ignores the format.
  # Level 9 over the default 3: the 0.12.1 desktop NAR shrank 11% (168.8 to
  # 150.9 MB) for about 6 s more; level 15 saved 2% more for 50 s.
  nix copy --to "file://$cache_dir?secret-key=$key_file&compression=zstd&compression-level=9" \
    --option builders '' "${output_paths[@]}"
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
