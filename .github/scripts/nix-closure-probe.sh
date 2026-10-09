#!/usr/bin/env bash
set -euo pipefail

readonly desktop_attr=".#packages.aarch64-darwin.desktop"
readonly probe_key_name="paseo-nix-seed-20261009-164633"
readonly seed_release_tag="nix-closure-probe-seed-20261009-164633"
readonly seed_archive_name="paseo-nix-node-seed-fd5cc4bfe827035b00e1f4d46325f292d1222418538c458d4e44acc4a3ae3ce6.tar"
readonly seed_archive_sha256="fd5cc4bfe827035b00e1f4d46325f292d1222418538c458d4e44acc4a3ae3ce6"
readonly seed_archive_bytes="69248000"
readonly seed_manifest_name="paseo-nix-node-seed-manifest-e56d4559861824682c1a85f3871919ab23deb6a520912b4daa8ad021b2b576c6.json"
readonly seed_manifest_sha256="e56d4559861824682c1a85f3871919ab23deb6a520912b4daa8ad021b2b576c6"
readonly seed_manifest_path="/nix/store/1wih4vhhsxkvmjnn8043xk13nhdp1d5r-paseo-nix-seed-manifest-119dda15072d5af0f4083a23eaf411587f621f95.json"
readonly seed_source_sha="119dda15072d5af0f4083a23eaf411587f621f95"
readonly seed_lock_hash="2e8911706b05e02f12256848cd3c14482e88f99a65401cee3ded4aa761db3ee3"
readonly seed_cache_bytes="68832100"
readonly seed_cache_file_count="143"
readonly seed_node_roots=(
  "/nix/store/3vd5kgvc7l4hcg5mlr21f09inywmfnd6-nodejs-slim-26.11.0"
  "/nix/store/w9a1j4q81r51fc2z2fgadh8z61ndyyay-nodejs-slim-26.11.0-dev"
  "/nix/store/1fql7h7fk180qd6w2mq53yb2lq62bck3-nodejs-slim-26.11.0-libv8"
  "/nix/store/kcnpxkgv8kmdmdk0bcfip9i4w2lzwrfi-nodejs-slim-26.11.0-npm"
  "/nix/store/bgcnlqy8rr1g3hcrvrkfwbqz329wwh6n-nodejs-26.11.0"
)
readonly seed_node_derivers=(
  "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv"
  "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv"
  "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv"
  "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv"
  "/nix/store/z8xk2h5gf7l5y60h0kmx3vpz617n4s3r-nodejs-26.11.0.drv"
)
readonly min_free_kib=2500000

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_arm64_darwin() {
  local nix_version nix_store_add_help nix_path_info_help
  nix_version="$(nix --version)"
  [[ "$nix_version" == "nix (Nix) 2.34.7" ]] \
    || fail "Expected the pinned Nix 2.34.7 CLI; got $nix_version."
  nix_store_add_help="$(nix store add --help)"
  [[ "$nix_store_add_help" == *"--mode"* ]] || fail "Nix CLI lacks nix store add --mode."
  nix store cat --help >/dev/null || fail "Nix CLI lacks nix store cat."
  nix_path_info_help="$(nix path-info --help)"
  [[ "$nix_path_info_help" == *"--derivation"* ]] || fail "Nix CLI lacks nix path-info --derivation."
  [[ "$(uname -m)" == arm64 ]] || fail "Expected an ARM64 runner; uname -m was $(uname -m)."
  [[ "$(nix eval --raw --impure --expr builtins.currentSystem)" == aarch64-darwin ]] \
    || fail "Nix is not running on aarch64-darwin."
}

write_output() {
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}

free_disk_kib() {
  df -k "$1" | awk 'END {print $4}'
}

check_free_disk() {
  local disk_path free_kib
  for disk_path in "$@"; do
    free_kib="$(free_disk_kib "$disk_path")"
    [[ "$free_kib" =~ ^[0-9]+$ ]] || fail "Could not measure free disk space at $disk_path."
    [[ "$free_kib" -ge "$min_free_kib" ]] \
      || fail "Only $free_kib KiB is free at $disk_path; need at least $min_free_kib KiB for closure staging."
  done
}

import_seeded_node() {
  local seed_dir archive_file manifest_file cache_dir extracted_bytes extracted_file_count
  local seed_closure_json imported_closure_json seed_output actual_deriver
  local index nix_bin

  [[ "${GITHUB_REPOSITORY:-}" == "iExalt/paseo" ]] \
    || fail "Refusing to access release assets for unexpected repository: ${GITHUB_REPOSITORY:-unset}."
  [[ -n "${NIX_PROBE_PUBLIC_KEY:-}" && "$NIX_PROBE_PUBLIC_KEY" == "$probe_key_name":* ]] \
    || fail "The reviewed seed public-key pin is absent or has the wrong key name."
  nix_bin="$(command -v nix)"

  seed_dir="$RUNNER_TEMP/paseo-nix-seed-download"
  archive_file="$seed_dir/$seed_archive_name"
  manifest_file="$seed_dir/$seed_manifest_name"
  cache_dir="$RUNNER_TEMP/paseo-nix-seed-cache"
  mkdir -p "$seed_dir" "$cache_dir"
  gh release download "$seed_release_tag" --repo "$GITHUB_REPOSITORY" \
    --pattern "$seed_archive_name" --pattern "$seed_manifest_name" --dir "$seed_dir"
  [[ -s "$archive_file" && -s "$manifest_file" ]] || fail "The immutable Node seed assets are missing."
  [[ "$(stat -f%z "$archive_file")" == "$seed_archive_bytes" ]] || fail "Node seed archive size differs from its source pin."
  [[ "$(shasum -a 256 "$archive_file" | awk '{print $1}')" == "$seed_archive_sha256" ]] \
    || fail "Node seed archive hash differs from its source pin."
  [[ "$(shasum -a 256 "$manifest_file" | awk '{print $1}')" == "$seed_manifest_sha256" ]] \
    || fail "Node seed manifest hash differs from its source pin."
  [[ "$(shasum -a 256 flake.lock | awk '{print $1}')" == "$seed_lock_hash" ]] \
    || fail "Current source flake.lock differs from the Node seed's pinned lock."
  jq -e \
    --arg sourceSha "$seed_source_sha" \
    --arg lockHash "$seed_lock_hash" \
    --arg signingKey "$NIX_PROBE_PUBLIC_KEY" \
    --argjson roots "$(printf '%s\n' "${seed_node_roots[@]}" | jq -R . | jq -s .)" \
    '.schemaVersion == 1 and .provenance == "local-built-dependency"
      and .sourceSha == $sourceSha and .lockHash == $lockHash
      and .sourceRevCount == 5787 and .signingKey == $signingKey
      and .system == "aarch64-darwin"
      and .roots == $roots' \
    "$manifest_file" >/dev/null || fail "Node seed manifest differs from its reviewed source pins."
  [[ "$(jq -er '.closure | length' "$manifest_file")" == 70 ]] \
    || fail "Node seed manifest closure size differs from its source pin."
  jq -e \
    'any(.closure[]; .path == "/nix/store/3vd5kgvc7l4hcg5mlr21f09inywmfnd6-nodejs-slim-26.11.0" and .deriver == "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv" and .narHash == "sha256-AC3iz3Jjnpc5jGN1jwft5ogAszXy7YSmF4hs3xi2nQA=")
      and any(.closure[]; .path == "/nix/store/w9a1j4q81r51fc2z2fgadh8z61ndyyay-nodejs-slim-26.11.0-dev" and .deriver == "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv" and .narHash == "sha256-rZZS+1V2SKzWTAKasyFgPQEyTOddt0C3Ieb8yHWpt2Q=")
      and any(.closure[]; .path == "/nix/store/1fql7h7fk180qd6w2mq53yb2lq62bck3-nodejs-slim-26.11.0-libv8" and .deriver == "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv" and .narHash == "sha256-8cf1TLvf3ehT6lJMKBPlOl3OquQ7fm7PYY2H6AKughQ=")
      and any(.closure[]; .path == "/nix/store/kcnpxkgv8kmdmdk0bcfip9i4w2lzwrfi-nodejs-slim-26.11.0-npm" and .deriver == "/nix/store/w4zdrzgs19rzd4wjyldrrhyk1j6nf0mr-nodejs-slim-26.11.0.drv" and .narHash == "sha256-OKOSWU0annub9kcVdENroo/rgcc+uiVdfOWAej7ezVs=")
      and any(.closure[]; .path == "/nix/store/bgcnlqy8rr1g3hcrvrkfwbqz329wwh6n-nodejs-26.11.0" and .deriver == "/nix/store/z8xk2h5gf7l5y60h0kmx3vpz617n4s3r-nodejs-26.11.0.drv" and .narHash == "sha256-uyQhBVFDXISzATUgHJyjDDk3TqMtAwhVN2sV0c1jAAk=")' \
    "$manifest_file" >/dev/null || fail "Node seed manifest output paths or NAR hashes differ from their source pins."

  tar -tf "$archive_file" >/dev/null || fail "Node seed archive is not a readable tar archive."
  python3 - "$archive_file" "$cache_dir" <<'PY'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
with tarfile.open(archive_path, "r:") as archive:
    members = archive.getmembers()
    if not members:
        raise SystemExit("Nix seed cache archive is empty")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit(f"Unsafe Nix seed archive member: {member.name!r}")
    archive.extractall(destination, members=members)
PY
  extracted_bytes="$(find "$cache_dir" -type f -exec stat -f%z {} \; | awk '{sum += $1} END {print sum + 0}')"
  extracted_file_count="$(find "$cache_dir" -type f | wc -l | tr -d ' ')"
  [[ "$extracted_bytes" == "$seed_cache_bytes" && "$extracted_file_count" == "$seed_cache_file_count" ]] \
    || fail "Extracted Node seed cache size or file count differs from its manifest pin."

  sudo "$nix_bin" copy --from "file://$cache_dir" \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "${seed_node_roots[@]}" "$seed_manifest_path"
  sudo "$nix_bin" store copy-sigs --substituter "file://$cache_dir" --recursive \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "${seed_node_roots[@]}" "$seed_manifest_path"
  sudo "$nix_bin" store verify --recursive --sigs-needed 1 \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "${seed_node_roots[@]}" "$seed_manifest_path"
  for index in "${!seed_node_roots[@]}"; do
    actual_deriver="$(nix path-info --derivation "${seed_node_roots[$index]}")"
    [[ "$actual_deriver" == "${seed_node_derivers[$index]}" ]] \
      || fail "Seeded output ${seed_node_roots[$index]} has deriver $actual_deriver, expected ${seed_node_derivers[$index]}."
  done
  nix store cat "$seed_manifest_path" > "$RUNNER_TEMP/paseo-nix-seed-imported-manifest.json"
  cmp -s "$manifest_file" "$RUNNER_TEMP/paseo-nix-seed-imported-manifest.json" \
    || fail "Imported Node seed manifest content differs from the independently pinned asset."
  seed_closure_json="$(jq -cS '.closure | map({path, narHash, narSize}) | sort_by(.path)' "$manifest_file")"
  imported_closure_json="$(nix path-info --json --recursive --option builders '' \
    --option substituters '' --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "${seed_node_roots[@]}" | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  [[ "$seed_closure_json" == "$imported_closure_json" ]] \
    || fail "Imported Node seed closure differs from the independently pinned path/NAR manifest."
  seed_output="${seed_node_roots[0]}"
  echo "::notice::Imported locally-built Node 26.11 seed ($seed_output) with signature verification; this seed is not claimed as CI-built. Manifest: $seed_manifest_path"
}

build_and_export() {
  local source_sha source_rev_count lock_hash lock_hash_checkout
  local checkout_drv checkout_output archive_drv archive_output package_version build_version
  local output_path derivation_path closure_json manifest_file manifest_path cache_dir
  local key_file release_tag asset_name archive_file tar_size cache_file_bytes cache_file_count
  local parity_started build_started export_started archive_started upload_started
  local parity_seconds build_seconds export_seconds archive_seconds upload_seconds
  local prebuild_store_free_kib prebuild_temp_free_kib preexport_store_free_kib preexport_temp_free_kib
  local bundle_plist bundle_build_version node_drv nodejs_drv

  [[ "${GITHUB_EVENT_NAME:-}" == push ]] || fail "This probe only runs for a dev push."
  [[ "${GITHUB_REF:-}" == refs/heads/dev ]] || fail "This probe only runs on dev."
  [[ "${GITHUB_REPOSITORY:-}" == "iExalt/paseo" ]] || fail "Refusing to publish from unexpected repository: ${GITHUB_REPOSITORY:-unset}."
  require_arm64_darwin

  source_sha="$(git rev-parse HEAD)"
  [[ "$source_sha" == "${GITHUB_SHA:?}" ]] || fail "Checkout HEAD does not match the triggering immutable SHA."
  [[ -z "$(git status --porcelain)" ]] || fail "The canonical checkout is not clean."
  source_rev_count="$(git rev-list --count HEAD)"
  lock_hash="$(shasum -a 256 flake.lock | awk '{print $1}')"
  lock_hash_checkout="$(git show HEAD:flake.lock | shasum -a 256 | awk '{print $1}')"
  [[ "$lock_hash" == "$lock_hash_checkout" ]] || fail "flake.lock differs from the triggering commit."
  [[ "$lock_hash" == "$seed_lock_hash" ]] || fail "Canonical checkout flake.lock differs from the pinned Node seed lock."
  [[ -n "${NIX_PROBE_SIGNING_KEY:-}" ]] || fail "The Nix closure probe signing secret is unavailable."

  import_seeded_node

  # Evaluate the same immutable source through a Git checkout and GitHub's
  # archive transport. The desktop derivation must not depend on revCount.
  parity_started="$(date +%s)"
  checkout_drv="$(nix eval --raw --no-update-lock-file "$desktop_attr.drvPath")"
  checkout_output="$(nix eval --raw --no-update-lock-file "$desktop_attr.outPath")"
  archive_ref="github:iExalt/paseo/$source_sha"
  archive_drv="$(nix eval --raw --no-update-lock-file "$archive_ref#packages.aarch64-darwin.desktop.drvPath")"
  archive_output="$(nix eval --raw --no-update-lock-file "$archive_ref#packages.aarch64-darwin.desktop.outPath")"
  [[ "$checkout_drv" == "$archive_drv" ]] \
    || fail "Checkout and source archive drvPath differ: $checkout_drv != $archive_drv."
  [[ "$checkout_output" == "$archive_output" ]] \
    || fail "Checkout and source archive output paths differ: $checkout_output != $archive_output."
  node_drv="$(nix eval --raw --no-update-lock-file --impure --expr 'let flake = builtins.getFlake (toString ./.); pkgs = import flake.inputs.nixpkgs { system = "aarch64-darwin"; overlays = [ (final: prev: import ./nix/runtime-overrides.nix { inherit final prev; }) ]; }; in pkgs.nodejs-slim_26.drvPath')"
  [[ "$node_drv" == "${seed_node_derivers[0]}" ]] \
    || fail "Canonical checkout Node derivation differs from the pinned seed: $node_drv."
  nodejs_drv="$(nix eval --raw --no-update-lock-file --impure --expr 'let flake = builtins.getFlake (toString ./.); pkgs = import flake.inputs.nixpkgs { system = "aarch64-darwin"; overlays = [ (final: prev: import ./nix/runtime-overrides.nix { inherit final prev; }) ]; }; in pkgs.nodejs_26.drvPath')"
  [[ "$nodejs_drv" == "${seed_node_derivers[4]}" ]] \
    || fail "Canonical checkout Node wrapper derivation differs from the pinned seed: $nodejs_drv."
  parity_seconds="$(( $(date +%s) - parity_started ))"

  package_version="$(jq -er '.version' package.json)"
  build_version="$(jq -er '.version | capture("^(?<core>[0-9]+\\.[0-9]+\\.[0-9]+)").core' package.json)"
  [[ "$(nix eval --raw --no-update-lock-file .#packages.aarch64-darwin.paseo.version)" == "$package_version" ]] \
    || fail "Nix package version differs from package.json."
  derivation_path="$checkout_drv"

  prebuild_store_free_kib="$(free_disk_kib /nix/store)"
  prebuild_temp_free_kib="$(free_disk_kib "$RUNNER_TEMP")"
  check_free_disk /nix/store "$RUNNER_TEMP"
  build_started="$(date +%s)"
  output_path="$(nix build --no-link --print-out-paths --no-update-lock-file \
    --option builders '' "$desktop_attr")"
  build_seconds="$(( $(date +%s) - build_started ))"
  [[ "$output_path" == "$checkout_output" ]] || fail "Built output path differs from evaluated output path."
  [[ "$(nix path-info --derivation "$output_path")" == "$derivation_path" ]] \
    || fail "Built output does not belong to the evaluated derivation."
  bundle_plist="$output_path/Applications/Paseo.app/Contents/Info.plist"
  bundle_build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$bundle_plist")"
  [[ "$bundle_build_version" == "$build_version" ]] \
    || fail "Built CFBundleVersion $bundle_build_version differs from manifest buildVersion $build_version."
  check_free_disk /nix/store "$RUNNER_TEMP"

  closure_json="$(nix path-info --json --recursive "$output_path" \
    | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  manifest_file="$RUNNER_TEMP/paseo-nix-closure-manifest.json"
  jq -nS \
    --arg sourceSha "$source_sha" \
    --argjson sourceRevCount "$source_rev_count" \
    --arg lockHash "$lock_hash" \
    --arg system aarch64-darwin \
    --arg attr "$desktop_attr" \
    --arg packageVersion "$package_version" \
    --arg buildVersion "$build_version" \
    --arg derivationPath "$derivation_path" \
    --arg outputPath "$output_path" \
    --argjson closure "$closure_json" \
    '{schemaVersion: 1, sourceSha: $sourceSha, sourceRevCount: $sourceRevCount,
      lockHash: $lockHash, system: $system, attr: $attr,
      packageVersion: $packageVersion, buildVersion: $buildVersion,
      derivationPath: $derivationPath, outputPath: $outputPath, closure: $closure}' \
    > "$manifest_file"

  manifest_path="$(nix store add --mode flat --name "paseo-nix-closure-manifest-$source_sha.json" "$manifest_file")"
  key_file="$RUNNER_TEMP/paseo-nix-probe-secret-key"
  cache_dir="$RUNNER_TEMP/paseo-nix-binary-cache"
  archive_file="$RUNNER_TEMP/paseo-nix-closure-$source_sha.tar"
  release_tag="nix-closure-probe-$source_sha"
  asset_name="paseo-nix-closure-$source_sha.tar"

  umask 077
  printf '%s\n' "$NIX_PROBE_SIGNING_KEY" > "$key_file"
  chmod 600 "$key_file"
  unset NIX_PROBE_SIGNING_KEY
  trap 'rm -f "$RUNNER_TEMP/paseo-nix-probe-secret-key"' EXIT
  [[ "$(nix key convert-secret-to-public < "$key_file")" == "${NIX_PROBE_PUBLIC_KEY:?}" ]] \
    || fail "The ephemeral signing secret does not match the reviewed public-key pin."

  preexport_store_free_kib="$(free_disk_kib /nix/store)"
  preexport_temp_free_kib="$(free_disk_kib "$RUNNER_TEMP")"
  check_free_disk /nix/store "$RUNNER_TEMP"
  export_started="$(date +%s)"
  nix copy --to "file://$cache_dir?secret-key=$key_file" \
    --option builders '' "$output_path" "$manifest_path"
  export_seconds="$(( $(date +%s) - export_started ))"
  rm -f "$key_file"
  trap - EXIT
  cache_file_count="$(find "$cache_dir" -type f | wc -l | tr -d ' ')"
  cache_file_bytes="$(find "$cache_dir" -type f -exec stat -f%z {} \; | awk '{sum += $1} END {print sum + 0}')"
  [[ "$cache_file_count" -gt 0 && "$cache_file_bytes" -gt 0 ]] || fail "The exported binary cache is empty."
  archive_started="$(date +%s)"
  tar -cf "$archive_file" -C "$cache_dir" .
  tar_size="$(stat -f%z "$archive_file")"
  archive_seconds="$(( $(date +%s) - archive_started ))"

  upload_started="$(date +%s)"
  gh release create "$release_tag" "$archive_file" --repo "$GITHUB_REPOSITORY" \
    --draft \
    --target "$source_sha" \
    --title "Nix closure probe $source_sha" \
    --notes "Probe-only signed Nix closure for immutable source $source_sha. Not a product release."
  upload_seconds="$(( $(date +%s) - upload_started ))"

  write_output source_sha "$source_sha"
  write_output source_rev_count "$source_rev_count"
  write_output lock_hash "$lock_hash"
  write_output output_path "$output_path"
  write_output manifest_path "$manifest_path"
  write_output release_tag "$release_tag"
  write_output asset_name "$asset_name"
  write_output archive_bytes "$tar_size"
  write_output cache_bytes "$cache_file_bytes"
  write_output cache_file_count "$cache_file_count"

  {
    echo "### Nix closure probe export"
    echo "- Source: \`$source_sha\` (git revCount $source_rev_count)"
    echo "- flake.lock SHA-256: \`$lock_hash\`"
    echo "- Checkout/archive metadata parity eval: ${parity_seconds}s"
    echo "- Checkout/archive drvPath equality: \`$checkout_drv\`"
    echo "- Checkout/archive output-path equality: \`$checkout_output\`"
    echo "- Local desktop build: ${build_seconds}s; cache export/signing: ${export_seconds}s"
    echo "- Built CFBundleVersion: \`$bundle_build_version\`"
    echo "- Free disk before build (store/temp): $prebuild_store_free_kib / $prebuild_temp_free_kib KiB"
    echo "- Free disk before export (store/temp): $preexport_store_free_kib / $preexport_temp_free_kib KiB"
    echo "- Closure cache: $cache_file_count regular files, $cache_file_bytes bytes"
    echo "- Tar creation: ${archive_seconds}s; GitHub Release upload: ${upload_seconds}s"
    echo "- Release asset: \`$asset_name\`, $tar_size bytes (cache was already NAR-compressed)"
    echo "- Output: \`$output_path\`"
    echo "- Producer-pinned content-addressed manifest path: \`$manifest_path\`"
  } >> "$GITHUB_STEP_SUMMARY"
}

verify_import() {
  local current_sha current_rev_count current_lock_hash download_dir archive_file cache_dir
  local release_tag asset_name store_root state_root destination_store manifest_file closure_json
  local package_version build_version download_started download_seconds import_started import_seconds verify_started verify_seconds
  local archive_bytes extracted_bytes extracted_file_count extracted_allocation store_allocation extraction_started extraction_seconds

  require_arm64_darwin
  [[ "$(git rev-parse HEAD)" == "${EXPECTED_SOURCE_SHA:?}" ]] || fail "Verifier checkout SHA mismatch."
  [[ "${GITHUB_REPOSITORY:-}" == "iExalt/paseo" ]] || fail "Refusing to download from unexpected repository: ${GITHUB_REPOSITORY:-unset}."
  [[ "$EXPECTED_SOURCE_SHA" == "${GITHUB_SHA:?}" ]] || fail "Expected SHA differs from the workflow event SHA."
  current_sha="$(git rev-parse HEAD)"
  current_rev_count="$(git rev-list --count HEAD)"
  current_lock_hash="$(shasum -a 256 flake.lock | awk '{print $1}')"
  package_version="$(jq -er '.version' package.json)"
  build_version="$(jq -er '.version | capture("^(?<core>[0-9]+\\.[0-9]+\\.[0-9]+)").core' package.json)"
  [[ "$current_sha" == "$EXPECTED_SOURCE_SHA" ]] || fail "Verifier checked out another source revision."
  [[ "$current_rev_count" == "${EXPECTED_SOURCE_REV_COUNT:?}" ]] \
    || fail "Verifier git revCount differs from producer output."
  [[ "$current_lock_hash" == "${EXPECTED_LOCK_HASH:?}" ]] || fail "Verifier flake.lock hash differs from producer output."
  [[ -n "${NIX_PROBE_PUBLIC_KEY:-}" && "$NIX_PROBE_PUBLIC_KEY" == "$probe_key_name":* ]] \
    || fail "The reviewed Nix public-key pin is absent or has the wrong key name."
  [[ "${EXPECTED_OUTPUT_PATH:?}" == /nix/store/* && "${EXPECTED_MANIFEST_PATH:?}" == /nix/store/* ]] \
    || fail "Producer supplied a non-canonical Nix store path."

  release_tag="${PROBE_RELEASE_TAG:?}"
  asset_name="${PROBE_ASSET_NAME:?}"
  [[ "$release_tag" == "nix-closure-probe-$EXPECTED_SOURCE_SHA" ]] \
    || fail "Unexpected probe release tag."
  [[ "$asset_name" == "paseo-nix-closure-$EXPECTED_SOURCE_SHA.tar" ]] \
    || fail "Unexpected probe asset name."
  check_free_disk /nix/store "$RUNNER_TEMP"

  download_dir="$RUNNER_TEMP/paseo-nix-probe-download"
  archive_file="$download_dir/$asset_name"
  cache_dir="$RUNNER_TEMP/paseo-nix-probe-extracted"
  store_root="$RUNNER_TEMP/paseo-nix-probe-root"
  state_root="$RUNNER_TEMP/paseo-nix-probe-state"
  manifest_file="$RUNNER_TEMP/paseo-nix-closure-manifest.json"
  mkdir -p "$download_dir" "$cache_dir"
  download_started="$(date +%s)"
  gh release download "$release_tag" --repo "$GITHUB_REPOSITORY" --pattern "$asset_name" --dir "$download_dir"
  download_seconds="$(( $(date +%s) - download_started ))"
  [[ -s "$archive_file" ]] || fail "The expected GitHub Release asset was not downloaded."
  archive_bytes="$(stat -f%z "$archive_file")"
  [[ "$archive_bytes" == "${EXPECTED_ARCHIVE_BYTES:?}" ]] || fail "Downloaded archive size differs from producer output."

  extraction_started="$(date +%s)"
  python3 - "$archive_file" "$cache_dir" <<'PY'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
with tarfile.open(archive_path, "r:") as archive:
    members = archive.getmembers()
    if not members:
        raise SystemExit("Nix cache archive is empty")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit(f"Unsafe cache archive member: {member.name!r}")
    archive.extractall(destination, members=members)
PY
  extraction_seconds="$(( $(date +%s) - extraction_started ))"

  destination_store="local?root=$store_root&state=$state_root&require-sigs=true"
  import_started="$(date +%s)"
  nix copy --from "file://$cache_dir" \
    --to "$destination_store" \
    --option builders '' \
    --option substituters '' \
    --option require-sigs true \
    --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "$EXPECTED_OUTPUT_PATH" "$EXPECTED_MANIFEST_PATH"
  import_seconds="$(( $(date +%s) - import_started ))"
  extracted_bytes="$(find "$cache_dir" -type f -exec stat -f%z {} \; | awk '{sum += $1} END {print sum + 0}')"
  extracted_allocation="$(du -sk "$cache_dir" | awk '{print $1}')"
  store_allocation="$(du -sk "$store_root" | awk '{print $1}')"
  [[ "$extracted_bytes" == "${EXPECTED_CACHE_BYTES:?}" ]] \
    || fail "Extracted cache bytes differ from producer output."
  extracted_file_count="$(find "$cache_dir" -type f | wc -l | tr -d ' ')"
  [[ "$extracted_file_count" == "${EXPECTED_CACHE_FILE_COUNT:?}" ]] \
    || fail "Extracted cache file count differs from producer output."

  # The manifest is content-addressed. Its expected store path comes only from
  # the trusted producer-job output; the downloaded archive cannot choose a
  # path or cause any field to be trusted. This is a same-run probe boundary,
  # not a standalone updater metadata-authentication design.
  nix store cat --store "$destination_store" "$EXPECTED_MANIFEST_PATH" > "$manifest_file"
  jq -e \
    --arg sourceSha "$EXPECTED_SOURCE_SHA" \
    --arg sourceRevCount "$EXPECTED_SOURCE_REV_COUNT" \
    --arg lockHash "$EXPECTED_LOCK_HASH" \
    --arg outputPath "$EXPECTED_OUTPUT_PATH" \
    --arg packageVersion "$package_version" \
    --arg buildVersion "$build_version" \
    '.schemaVersion == 1
      and .sourceSha == $sourceSha
      and (.sourceRevCount | tostring) == $sourceRevCount
      and .lockHash == $lockHash
      and .system == "aarch64-darwin"
      and .attr == ".#packages.aarch64-darwin.desktop"
      and .packageVersion == $packageVersion
      and .buildVersion == $buildVersion
      and .outputPath == $outputPath
      and any(.closure[]; .path == $outputPath)' \
    "$manifest_file" >/dev/null || fail "Imported manifest does not match the trusted producer outputs."

  verify_started="$(date +%s)"
  nix store verify --store "$destination_store" --recursive --sigs-needed 1 \
    --option builders '' \
    --option substituters '' \
    --option require-sigs true \
    --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "$EXPECTED_OUTPUT_PATH"
  closure_json="$(nix path-info --store "$destination_store" --json --recursive \
    --option builders '' --option substituters '' --option trusted-public-keys "$NIX_PROBE_PUBLIC_KEY" \
    "$EXPECTED_OUTPUT_PATH" \
    | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  jq -e --argjson imported "$closure_json" \
    '.closure == $imported' "$manifest_file" >/dev/null \
    || fail "Imported closure path/NAR metadata differs from the producer-pinned manifest."
  verify_seconds="$(( $(date +%s) - verify_started ))"

  {
    echo "### Nix closure probe verification"
    echo "- Source and lock hash match producer outputs and verifier checkout: \`$current_sha\`, \`$current_lock_hash\`"
    echo "- Imported manifest from producer-pinned path: \`${EXPECTED_MANIFEST_PATH}\`"
    echo "- Exact output imported with builders and substituters disabled: \`${EXPECTED_OUTPUT_PATH}\`"
    echo "- Download/archive: ${download_seconds}s / $archive_bytes bytes; extraction: ${extraction_seconds}s"
    echo "- Extracted cache: $extracted_file_count regular files / $extracted_bytes bytes"
    echo "- Import: ${import_seconds}s; recursive verify plus path/NAR comparison: ${verify_seconds}s"
    echo "- Rooted-store/extracted-cache allocation: $store_allocation KiB / $extracted_allocation KiB (ending allocation, not peak)"
    echo "- Recursive Nix signature verification: passed (one trusted signature required; content-addressed paths use Nix content-hash semantics)"
    echo "- Imported closure paths and NAR hashes/sizes: match manifest"
    echo "- Destination: separate rooted store at \`$store_root\` (logical paths remain /nix/store; no app launch)"
  } >> "$GITHUB_STEP_SUMMARY"
}

case "${1:-}" in
  build-and-export)
    build_and_export
    ;;
  verify-import)
    verify_import
    ;;
  *)
    fail "Usage: $0 {build-and-export|verify-import}"
    ;;
esac
