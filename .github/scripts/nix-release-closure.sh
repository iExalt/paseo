#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

readonly desktop_attr=".#packages.aarch64-darwin.desktop"
readonly release_public_key="paseo-nix-release-1:hOc4RkmgnDMh/+aZWDdwQKuZHDVvVPh0Fya+DNAA+b8="
readonly seed_public_key="paseo-nix-seed-20261009-164633:HKUIBntJ2BXdOwsTH8Z/ou1oO5sEXIUsU6ZiGuhWN54="
readonly seed_release_tag="nix-closure-probe-seed-20261009-164633"
readonly seed_archive_name="paseo-nix-node-seed-fd5cc4bfe827035b00e1f4d46325f292d1222418538c458d4e44acc4a3ae3ce6.tar"
readonly seed_archive_sha256="fd5cc4bfe827035b00e1f4d46325f292d1222418538c458d4e44acc4a3ae3ce6"
readonly seed_archive_bytes="69248000"
readonly seed_manifest_name="paseo-nix-node-seed-manifest-e56d4559861824682c1a85f3871919ab23deb6a520912b4daa8ad021b2b576c6.json"
readonly seed_manifest_sha256="e56d4559861824682c1a85f3871919ab23deb6a520912b4daa8ad021b2b576c6"
readonly seed_manifest_path="/nix/store/1wih4vhhsxkvmjnn8043xk13nhdp1d5r-paseo-nix-seed-manifest-119dda15072d5af0f4083a23eaf411587f621f95.json"
readonly seed_source_sha="119dda15072d5af0f4083a23eaf411587f621f95"
readonly seed_source_rev_count="5787"
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
readonly state_file="$RUNNER_TEMP/paseo-nix-closure-state.json"

fail() {
  echo "::error::$*" >&2
  exit 1
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

require_arm64_darwin() {
  local nix_version nix_store_add_help
  nix_version="$(nix --version)"
  [[ "$nix_version" == "nix (Nix) 2.34.7" ]] \
    || fail "Expected the pinned Nix 2.34.7 CLI; got $nix_version."
  nix_store_add_help="$(nix store add --help)"
  [[ "$nix_store_add_help" == *"--mode"* ]] || fail "Nix CLI lacks nix store add --mode."
  nix store cat --help >/dev/null || fail "Nix CLI lacks nix store cat."
  [[ "$(uname -m)" == arm64 ]] || fail "Expected an ARM64 runner; uname -m was $(uname -m)."
  [[ "$(nix eval --raw --impure --expr builtins.currentSystem)" == aarch64-darwin ]] \
    || fail "Nix is not running on aarch64-darwin."
}

validate_identity() {
  local source_sha fork_version
  source_sha="${SOURCE_SHA:?The immutable source SHA input is required.}"
  fork_version="${FORK_VERSION:?The fork version input is required.}"
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Source SHA must be 40 lowercase hexadecimal characters."
  node .github/scripts/candidate-identity.mjs "$source_sha" "$fork_version" >/dev/null
  [[ "${GITHUB_REPOSITORY:-}" == "iExalt/paseo" ]] \
    || fail "Refusing to run for unexpected repository: ${GITHUB_REPOSITORY:-unset}."
  [[ "${GITHUB_REF:-}" == "refs/heads/dev" ]] || fail "The Nix closure lane only accepts a dev-branch caller."
  [[ "${GITHUB_ACTOR:-}" == "iExalt" ]] || fail "The Nix closure lane only accepts the trusted iExalt caller."
  [[ "$source_sha" == "${GITHUB_SHA:?}" ]] || fail "Caller SHA differs from the immutable source SHA input."
  [[ "$(git rev-parse HEAD)" == "$source_sha" ]] || fail "Checkout HEAD differs from the immutable source SHA input."
  [[ -z "$(git status --porcelain)" ]] || fail "The canonical checkout is not clean."
  require_arm64_darwin
}

import_seeded_node() {
  local seed_dir archive_file manifest_file cache_dir extracted_bytes extracted_file_count
  local seed_closure_json imported_closure_json nix_bin node_bin

  [[ -n "$seed_public_key" && "$seed_public_key" == "paseo-nix-seed-20261009-164633":* ]] \
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
    --arg signingKey "$seed_public_key" \
    --argjson sourceRevCount "$seed_source_rev_count" \
    --argjson roots "$(printf '%s\n' "${seed_node_roots[@]}" | jq -R . | jq -s .)" \
    '.schemaVersion == 1 and .provenance == "local-built-dependency"
      and .sourceSha == $sourceSha and .lockHash == $lockHash
      and .sourceRevCount == $sourceRevCount and .signingKey == $signingKey
      and .system == "aarch64-darwin" and .roots == $roots' \
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
    cache_members = [member for member in members if not pathlib.PurePosixPath(member.name).name.startswith("._")]
    archive.extractall(destination, members=cache_members)
PY
  extracted_bytes="$(find "$cache_dir" -type f -exec stat -f%z {} \; | awk '{sum += $1} END {print sum + 0}')"
  extracted_file_count="$(find "$cache_dir" -type f | wc -l | tr -d ' ')"
  [[ "$extracted_bytes" == "$seed_cache_bytes" && "$extracted_file_count" == "$seed_cache_file_count" ]] \
    || fail "Extracted Node seed cache size or file count differs from its manifest pin."

  sudo "$nix_bin" --extra-experimental-features nix-command copy --from "file://$cache_dir" \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$seed_public_key" "${seed_node_roots[@]}" "$seed_manifest_path"
  sudo "$nix_bin" --extra-experimental-features nix-command store copy-sigs \
    --substituter "file://$cache_dir" --recursive \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$seed_public_key" "${seed_node_roots[@]}" "$seed_manifest_path"
  sudo "$nix_bin" --extra-experimental-features nix-command store verify --recursive --sigs-needed 1 \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$seed_public_key" "${seed_node_roots[@]}" "$seed_manifest_path"
  nix store cat "$seed_manifest_path" > "$RUNNER_TEMP/paseo-nix-seed-imported-manifest.json"
  cmp -s "$manifest_file" "$RUNNER_TEMP/paseo-nix-seed-imported-manifest.json" \
    || fail "Imported Node seed manifest content differs from its independently pinned asset."
  seed_closure_json="$(jq -cS '.closure | map({path, narHash, narSize}) | sort_by(.path)' "$manifest_file")"
  imported_closure_json="$(nix path-info --json --recursive --option builders '' \
    --option substituters '' --option trusted-public-keys "$seed_public_key" \
    "${seed_node_roots[@]}" | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  [[ "$seed_closure_json" == "$imported_closure_json" ]] \
    || fail "Imported Node seed closure differs from the independently pinned path/NAR manifest."

  node_bin="${seed_node_roots[4]}/bin/node"
  [[ -x "$node_bin" ]] || fail "The imported Node seed lacks its pinned Node 26 runtime."
  PASEO_NIX_SIGNATURE_FIXTURE=1 \
    PASEO_NIX_SIGNATURE_FIXTURE_ROOT="${seed_node_roots[4]}" \
    PASEO_NIX_SIGNATURE_FIXTURE_STORE=default \
    "$node_bin" --test --test-name-pattern='copies only the pinned cache signature' \
      scripts/paseo-nix-update.test.mjs
}

prepare() {
  local source_sha fork_version lock_hash lock_hash_checkout checkout_drv checkout_output
  local archive_drv archive_output node_drv nodejs_drv package_version build_version started seed_seconds parity_seconds
  local prebuild_store_free_kib prebuild_temp_free_kib

  validate_identity
  source_sha="$SOURCE_SHA"
  fork_version="$FORK_VERSION"
  lock_hash="$(shasum -a 256 flake.lock | awk '{print $1}')"
  lock_hash_checkout="$(git show HEAD:flake.lock | shasum -a 256 | awk '{print $1}')"
  [[ "$lock_hash" == "$lock_hash_checkout" ]] || fail "flake.lock differs from the triggering commit."
  [[ "$lock_hash" == "$seed_lock_hash" ]] || fail "Canonical checkout flake.lock differs from the pinned Node seed lock."

  started="$(date +%s)"
  import_seeded_node
  seed_seconds="$(( $(date +%s) - started ))"

  started="$(date +%s)"
  checkout_drv="$(nix eval --raw --no-update-lock-file "$desktop_attr.drvPath")"
  checkout_output="$(nix eval --raw --no-update-lock-file "$desktop_attr.outPath")"
  archive_ref="github:iExalt/paseo/$source_sha"
  archive_drv="$(nix eval --raw --no-update-lock-file "$archive_ref#packages.aarch64-darwin.desktop.drvPath")"
  archive_output="$(nix eval --raw --no-update-lock-file "$archive_ref#packages.aarch64-darwin.desktop.outPath")"
  [[ "$checkout_drv" == "$archive_drv" ]] || fail "Checkout and source archive drvPath differ."
  [[ "$checkout_output" == "$archive_output" ]] || fail "Checkout and source archive output paths differ."
  node_drv="$(nix eval --raw --no-update-lock-file --impure --expr 'let flake = builtins.getFlake (toString ./.); pkgs = import flake.inputs.nixpkgs { system = "aarch64-darwin"; overlays = [ (final: prev: import ./nix/runtime-overrides.nix { inherit final prev; }) ]; }; in pkgs.nodejs-slim_26.drvPath')"
  [[ "$node_drv" == "${seed_node_derivers[0]}" ]] || fail "Canonical Node derivation differs from the pinned local-built seed."
  nodejs_drv="$(nix eval --raw --no-update-lock-file --impure --expr 'let flake = builtins.getFlake (toString ./.); pkgs = import flake.inputs.nixpkgs { system = "aarch64-darwin"; overlays = [ (final: prev: import ./nix/runtime-overrides.nix { inherit final prev; }) ]; }; in pkgs.nodejs_26.drvPath')"
  [[ "$nodejs_drv" == "${seed_node_derivers[4]}" ]] || fail "Canonical Node wrapper derivation differs from the pinned local-built seed."
  parity_seconds="$(( $(date +%s) - started ))"

  package_version="$(jq -er '.version' package.json)"
  build_version="$(jq -er '.version | capture("^(?<core>[0-9]+\\.[0-9]+\\.[0-9]+)").core' package.json)"
  [[ "$(nix eval --raw --no-update-lock-file .#packages.aarch64-darwin.paseo.version)" == "$package_version" ]] \
    || fail "Nix package version differs from package.json."
  prebuild_store_free_kib="$(free_disk_kib /nix/store)"
  prebuild_temp_free_kib="$(free_disk_kib "$RUNNER_TEMP")"
  check_free_disk /nix/store "$RUNNER_TEMP"

  jq -nS \
    --arg sourceSha "$source_sha" --arg forkVersion "$fork_version" \
    --arg lockHash "$lock_hash" --arg system aarch64-darwin --arg attr "$desktop_attr" \
    --arg packageVersion "$package_version" --arg buildVersion "$build_version" \
    --arg derivationPath "$checkout_drv" --arg outputPath "$checkout_output" \
    --argjson seedImportSeconds "$seed_seconds" --argjson paritySeconds "$parity_seconds" \
    --argjson prebuildStoreFreeKiB "$prebuild_store_free_kib" \
    --argjson prebuildTempFreeKiB "$prebuild_temp_free_kib" \
    '{sourceSha: $sourceSha, forkVersion: $forkVersion, lockHash: $lockHash,
      system: $system, attr: $attr, packageVersion: $packageVersion, buildVersion: $buildVersion,
      derivationPath: $derivationPath, outputPath: $outputPath,
      seedImportSeconds: $seedImportSeconds, paritySeconds: $paritySeconds,
      prebuildStoreFreeKiB: $prebuildStoreFreeKiB, prebuildTempFreeKiB: $prebuildTempFreeKiB}' \
    > "$state_file"

  write_output source_sha "$source_sha"
  write_output fork_version "$fork_version"
  write_output lock_hash "$lock_hash"
  write_output output_path "$checkout_output"
  {
    echo "### Nix closure build checkpoint"
    echo "- Source SHA: \`$source_sha\`; fork version: $fork_version; flake.lock SHA-256: \`$lock_hash\`."
    echo "- Imported and signature-verified the reviewed local-built Node 26.11 seed in ${seed_seconds}s."
    echo "- Isolated Nix signature-copy fixture passed for an input-addressed path; only the ephemeral fixture key verified."
    echo "- Checkout/archive derivation and output paths match in ${parity_seconds}s: \`$checkout_drv\` / \`$checkout_output\`."
    echo "- Free disk before build (store/temp): $prebuild_store_free_kib / $prebuild_temp_free_kib KiB."
    echo "- Seed provenance is local-built; this lane does not claim CI-built Node dependencies."
  } >> "$GITHUB_STEP_SUMMARY"
}

build() {
  local source_sha fork_version lock_hash output_path derivation_path package_version build_version
  local build_started build_seconds bundle_plist bundle_build_version closure_json manifest_file manifest_path
  local prebuild_store_free_kib prebuild_temp_free_kib

  [[ -s "$state_file" ]] || fail "Prepared Nix build state is missing."
  source_sha="$(jq -er '.sourceSha' "$state_file")"
  fork_version="$(jq -er '.forkVersion' "$state_file")"
  lock_hash="$(jq -er '.lockHash' "$state_file")"
  output_path="$(jq -er '.outputPath' "$state_file")"
  derivation_path="$(jq -er '.derivationPath' "$state_file")"
  package_version="$(jq -er '.packageVersion' "$state_file")"
  build_version="$(jq -er '.buildVersion' "$state_file")"
  prebuild_store_free_kib="$(jq -er '.prebuildStoreFreeKiB' "$state_file")"
  prebuild_temp_free_kib="$(jq -er '.prebuildTempFreeKiB' "$state_file")"
  [[ "$source_sha" == "$SOURCE_SHA" && "$fork_version" == "$FORK_VERSION" ]] \
    || fail "Prepared build state does not match the requested immutable identity."
  [[ "$(git rev-parse HEAD)" == "$source_sha" && "$(shasum -a 256 flake.lock | awk '{print $1}')" == "$lock_hash" ]] \
    || fail "Source or lock changed after preparation."

  build_started="$(date +%s)"
  output_path="$(nix build --no-link --print-out-paths --no-update-lock-file \
    --option builders '' "$desktop_attr")"
  build_seconds="$(( $(date +%s) - build_started ))"
  [[ "$output_path" == "$(jq -er '.outputPath' "$state_file")" ]] || fail "Built output differs from its evaluated path."
  bundle_plist="$output_path/Applications/Paseo.app/Contents/Info.plist"
  bundle_build_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$bundle_plist")"
  [[ "$bundle_build_version" == "$build_version" ]] || fail "Built CFBundleVersion differs from package version metadata."
  check_free_disk /nix/store "$RUNNER_TEMP"
  closure_json="$(nix path-info --json --recursive "$output_path" \
    | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"

  manifest_file="$RUNNER_TEMP/paseo-nix-closure-manifest.json"
  jq -nS \
    --arg sourceSha "$source_sha" --arg forkVersion "$fork_version" \
    --arg lockHash "$lock_hash" --arg system aarch64-darwin --arg attr "$desktop_attr" \
    --arg packageVersion "$package_version" --arg buildVersion "$build_version" \
    --arg derivationPath "$derivation_path" --arg outputPath "$output_path" \
    --arg provenance local-ci-build --arg nodeSeedProvenance local-built-dependency \
    --arg seedSourceSha "$seed_source_sha" --arg seedLockHash "$seed_lock_hash" \
    --arg seedArchiveName "$seed_archive_name" --arg seedArchiveSha256 "$seed_archive_sha256" \
    --arg seedArchiveBytes "$seed_archive_bytes" --arg seedManifestName "$seed_manifest_name" \
    --arg seedManifestSha256 "$seed_manifest_sha256" --arg seedSigningKey "$seed_public_key" \
    --argjson seedSourceRevCount "$seed_source_rev_count" \
    --argjson seedRoots "$(printf '%s\n' "${seed_node_roots[@]}" | jq -R . | jq -s .)" \
    --argjson closure "$closure_json" \
    '{kind: "paseo-verification-candidate", schemaVersion: 2, platform: "macos-arm64", sourceSha: $sourceSha, forkVersion: $forkVersion,
      lockHash: $lockHash, system: $system, attr: $attr,
      packageVersion: $packageVersion, buildVersion: $buildVersion,
      derivationPath: $derivationPath, outputPath: $outputPath,
      provenance: $provenance, nodeSeedProvenance: $nodeSeedProvenance,
      nodeSeed: {provenance: $nodeSeedProvenance, sourceSha: $seedSourceSha,
        sourceRevCount: $seedSourceRevCount, lockHash: $seedLockHash,
        archive: {name: $seedArchiveName, sha256: $seedArchiveSha256, bytes: $seedArchiveBytes},
        manifest: {name: $seedManifestName, sha256: $seedManifestSha256},
        keyId: "paseo-nix-seed-20261009-164633", signingKey: $seedSigningKey,
        roots: $seedRoots}, closure: $closure}' \
    > "$manifest_file"
  manifest_path="$(nix store add --mode flat --name "paseo-nix-closure-manifest-$source_sha-$fork_version.json" "$manifest_file")"
  jq --arg manifestPath "$manifest_path" --arg manifestFile "$manifest_file" \
    --argjson buildSeconds "$build_seconds" --arg bundleBuildVersion "$bundle_build_version" \
    '. + {manifestPath: $manifestPath, manifestFile: $manifestFile,
      buildSeconds: $buildSeconds, bundleBuildVersion: $bundleBuildVersion}' \
    "$state_file" > "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
  write_output manifest_path "$manifest_path"
  write_output build_seconds "$build_seconds"
  {
    echo "### Nix desktop build"
    echo "- Build duration: ${build_seconds}s; built CFBundleVersion: \`$bundle_build_version\`."
    echo "- Output: \`$output_path\`; producer-pinned manifest path: \`$manifest_path\`."
    echo "- Closure entries: $(jq -er '.closure | length' "$manifest_file")."
    echo "- Free disk before build (store/temp): $prebuild_store_free_kib / $prebuild_temp_free_kib KiB."
    echo "- Manifest records local CI build provenance and local-built Node seed provenance separately."
  } >> "$GITHUB_STEP_SUMMARY"
}

export_signed_closure() {
  local source_sha fork_version output_path manifest_path manifest_file package_version build_version
  local key_file cache_dir artifact_dir archive_file asset_name artifact_name cache_file_bytes cache_file_count archive_bytes archive_sha256 manifest_sha256
  local export_started export_seconds archive_started archive_seconds store_free_kib temp_free_kib

  [[ -n "${NIX_RELEASE_SIGNING_KEY:-}" ]] || fail "The scoped Nix release signing secret is unavailable."
  [[ "${NIX_RELEASE_PUBLIC_KEY:-}" == "$release_public_key" ]] || fail "The reviewed Nix release public key differs from its source pin."
  [[ -s "$state_file" ]] || fail "Built closure state is missing."
  source_sha="$(jq -er '.sourceSha' "$state_file")"
  fork_version="$(jq -er '.forkVersion' "$state_file")"
  output_path="$(jq -er '.outputPath' "$state_file")"
  manifest_path="$(jq -er '.manifestPath' "$state_file")"
  manifest_file="$(jq -er '.manifestFile' "$state_file")"
  package_version="$(jq -er '.packageVersion' "$state_file")"
  build_version="$(jq -er '.buildVersion' "$state_file")"
  [[ "$source_sha" == "$SOURCE_SHA" && "$fork_version" == "$FORK_VERSION" ]] \
    || fail "Built closure state does not match the requested immutable identity."
  [[ "$(shasum -a 256 flake.lock | awk '{print $1}')" == "$(jq -er '.lockHash' "$state_file")" ]] \
    || fail "flake.lock changed before signing/export."
  [[ "$(nix store cat "$manifest_path" | shasum -a 256 | awk '{print $1}')" == "$(shasum -a 256 "$manifest_file" | awk '{print $1}')" ]] \
    || fail "Content-addressed manifest in the store differs from the build receipt."

  artifact_name="paseo-nix-closure-$source_sha-$fork_version-attempt-${GITHUB_RUN_ATTEMPT:?}"
  asset_name="$artifact_name.tar"
  cache_dir="$RUNNER_TEMP/paseo-nix-release-cache"
  artifact_dir="$RUNNER_TEMP/paseo-nix-release-artifact"
  archive_file="$artifact_dir/$asset_name"
  key_file="$RUNNER_TEMP/paseo-nix-release-secret-key"
  mkdir -p "$cache_dir" "$artifact_dir"
  store_free_kib="$(free_disk_kib /nix/store)"
  temp_free_kib="$(free_disk_kib "$RUNNER_TEMP")"
  check_free_disk /nix/store "$RUNNER_TEMP"

  [[ ! -e "$key_file" ]] || fail "Refusing to overwrite an existing temporary Nix signing key file."
  trap 'rm -f "$RUNNER_TEMP/paseo-nix-release-secret-key"' EXIT
  umask 077
  printf '%s\n' "$NIX_RELEASE_SIGNING_KEY" > "$key_file"
  chmod 600 "$key_file"
  unset NIX_RELEASE_SIGNING_KEY
  [[ "$(nix key convert-secret-to-public < "$key_file")" == "$NIX_RELEASE_PUBLIC_KEY" ]] \
    || fail "The scoped signing secret does not match the reviewed Nix public-key pin."
  # Existing store paths may have signatures from their original cache only.
  # Add this release key to every runtime reference before exporting so a
  # fresh store can verify the full closure with the single pinned key.
  nix store sign --key-file "$key_file" --recursive "$output_path" "$manifest_path"
  export_started="$(date +%s)"
  nix copy --to "file://$cache_dir?secret-key=$key_file" --option builders '' "$output_path" "$manifest_path"
  export_seconds="$(( $(date +%s) - export_started ))"
  rm -f "$key_file"
  trap - EXIT

  cache_file_count="$(find "$cache_dir" -type f | wc -l | tr -d ' ')"
  cache_file_bytes="$(find "$cache_dir" -type f -exec stat -f%z {} \; | awk '{sum += $1} END {print sum + 0}')"
  [[ "$cache_file_count" -gt 0 && "$cache_file_bytes" -gt 0 ]] || fail "The signed binary cache is empty."
  nix store cat "$manifest_path" > "$artifact_dir/manifest.json"
  archive_started="$(date +%s)"
  COPYFILE_DISABLE=1 tar -cf "$archive_file" -C "$cache_dir" .
  archive_seconds="$(( $(date +%s) - archive_started ))"
  archive_bytes="$(stat -f%z "$archive_file")"
  [[ "$archive_bytes" -le 2147483648 ]] || fail "Verification archive exceeds the 2 GiB transfer bound."
  archive_sha256="$(shasum -a 256 "$archive_file" | awk '{print $1}')"
  manifest_sha256="$(shasum -a 256 "$artifact_dir/manifest.json" | awk '{print $1}')"
  (cd "$artifact_dir" && shasum -a 256 "$asset_name" manifest.json > SHA256SUMS)
  write_output artifact_name "$artifact_name"
  write_output archive_name "$asset_name"
  write_output archive_bytes "$archive_bytes"
  write_output archive_sha256 "$archive_sha256"
  write_output cache_bytes "$cache_file_bytes"
  write_output cache_file_count "$cache_file_count"
  write_output manifest_sha256 "$manifest_sha256"
  {
    echo "### Signed Nix closure artifact"
    echo "- Artifact: \`$artifact_name\`; source: \`$source_sha\`; fork version: $fork_version."
    echo "- Binary cache: $cache_file_count regular files / $cache_file_bytes bytes; tar: $archive_bytes bytes."
    echo "- Export/signing: ${export_seconds}s; tar creation: ${archive_seconds}s."
    echo "- Free disk before export (store/temp): $store_free_kib / $temp_free_kib KiB."
    echo "- Nix key was exposed only to this export/sign step and its temporary private-key file was removed."
    echo "- Manifest SHA-256: \`$manifest_sha256\`."
  } >> "$GITHUB_STEP_SUMMARY"
}

verify_import() {
  local source_sha fork_version expected_manifest_sha expected_archive_sha expected_output expected_manifest expected_lock
  local package_version build_version artifact_name archive_name artifact_dir archive_file cache_dir
  local manifest_file store_root state_root destination_store archive_bytes extracted_bytes extracted_file_count
  local extraction_started extraction_seconds import_started import_seconds verify_started verify_seconds closure_json

  validate_identity
  source_sha="$SOURCE_SHA"
  fork_version="$FORK_VERSION"
  expected_manifest_sha="${EXPECTED_MANIFEST_SHA256:?Expected manifest digest is required.}"
  expected_archive_sha="${EXPECTED_ARCHIVE_SHA256:?Expected archive digest is required.}"
  expected_output="${EXPECTED_OUTPUT_PATH:?Expected output path is required.}"
  expected_manifest="${EXPECTED_MANIFEST_PATH:?Expected manifest path is required.}"
  expected_lock="${EXPECTED_LOCK_HASH:?Expected flake.lock hash is required.}"
  artifact_name="${EXPECTED_ARTIFACT_NAME:?Expected artifact name is required.}"
  archive_name="${EXPECTED_ARCHIVE_NAME:?Expected archive name is required.}"
  [[ "$expected_output" == /nix/store/* && "$expected_manifest" == /nix/store/* ]] \
    || fail "Producer supplied non-canonical Nix store paths."
  [[ "$(shasum -a 256 flake.lock | awk '{print $1}')" == "$expected_lock" ]] \
    || fail "Verifier flake.lock hash differs from producer output."
  [[ "$artifact_name" == "paseo-nix-closure-$source_sha-$fork_version-attempt-${GITHUB_RUN_ATTEMPT:?}" \
    && "$archive_name" == "$artifact_name.tar" ]] || fail "Artifact name does not match the immutable build identity."
  [[ "${NIX_RELEASE_PUBLIC_KEY:-}" == "$release_public_key" ]] || fail "The reviewed Nix release public key differs from its source pin."
  check_free_disk /nix/store "$RUNNER_TEMP"

  artifact_dir="${ARTIFACT_DIR:-$RUNNER_TEMP/paseo-nix-release-artifact}"
  archive_file="$artifact_dir/$archive_name"
  manifest_file="$artifact_dir/manifest.json"
  cache_dir="$RUNNER_TEMP/paseo-nix-release-extracted"
  store_root="$RUNNER_TEMP/paseo-nix-release-root"
  state_root="$RUNNER_TEMP/paseo-nix-release-state"
  [[ -s "$archive_file" && -s "$manifest_file" && -s "$artifact_dir/SHA256SUMS" ]] \
    || fail "The producer closure artifact is incomplete."
  (cd "$artifact_dir" && shasum -a 256 -c SHA256SUMS)
  [[ "$(shasum -a 256 "$manifest_file" | awk '{print $1}')" == "$expected_manifest_sha" ]] \
    || fail "Manifest hash differs from the trusted producer job output."
  archive_bytes="$(stat -f%z "$archive_file")"
  [[ "$archive_bytes" == "${EXPECTED_ARCHIVE_BYTES:?Expected archive size is required.}" ]] \
    || fail "Downloaded artifact archive size differs from producer output."
  [[ "$(shasum -a 256 "$archive_file" | awk '{print $1}')" == "$expected_archive_sha" ]] \
    || fail "Archive hash differs from the trusted producer job output."

  mkdir -p "$cache_dir"
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
        raise SystemExit("Nix closure cache archive is empty")
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit(f"Unsafe Nix closure cache member: {member.name!r}")
    cache_members = [member for member in members if not pathlib.PurePosixPath(member.name).name.startswith("._")]
    archive.extractall(destination, members=cache_members)
PY
  extraction_seconds="$(( $(date +%s) - extraction_started ))"
  extracted_bytes="$(find "$cache_dir" -type f -exec stat -f%z {} \; | awk '{sum += $1} END {print sum + 0}')"
  extracted_file_count="$(find "$cache_dir" -type f | wc -l | tr -d ' ')"
  [[ "$extracted_bytes" == "${EXPECTED_CACHE_BYTES:?Expected cache size is required.}" ]] \
    || fail "Extracted cache bytes differ from producer output."
  [[ "$extracted_file_count" == "${EXPECTED_CACHE_FILE_COUNT:?Expected cache file count is required.}" ]] \
    || fail "Extracted cache file count differs from producer output."

  package_version="$(jq -er '.version' package.json)"
  build_version="$(jq -er '.version | capture("^(?<core>[0-9]+\\.[0-9]+\\.[0-9]+)").core' package.json)"
  jq -e \
    --arg sourceSha "$source_sha" --arg forkVersion "$fork_version" \
    --arg lockHash "$expected_lock" --arg outputPath "$expected_output" \
    --arg packageVersion "$package_version" --arg buildVersion "$build_version" \
    --arg seedSourceSha "$seed_source_sha" --arg seedLockHash "$seed_lock_hash" \
    --arg seedArchiveName "$seed_archive_name" --arg seedArchiveBytes "$seed_archive_bytes" \
    --arg seedArchiveSha256 "$seed_archive_sha256" --arg seedManifestName "$seed_manifest_name" \
    --arg seedManifestSha256 "$seed_manifest_sha256" --arg seedKeyId "paseo-nix-seed-20261009-164633" \
    --arg seedSigningKey "$seed_public_key" --argjson seedSourceRevCount "$seed_source_rev_count" \
    --argjson seedRoots "$(printf '%s\n' "${seed_node_roots[@]}" | jq -R . | jq -s .)" \
    '.kind == "paseo-verification-candidate" and .schemaVersion == 2
      and .platform == "macos-arm64" and (has("releaseSequence") | not) and .sourceSha == $sourceSha
      and (.forkVersion | tostring) == $forkVersion and .lockHash == $lockHash
      and .system == "aarch64-darwin" and .attr == ".#packages.aarch64-darwin.desktop"
      and .packageVersion == $packageVersion and .buildVersion == $buildVersion
      and .outputPath == $outputPath and .provenance == "local-ci-build"
      and .nodeSeedProvenance == "local-built-dependency"
      and .nodeSeed.provenance == "local-built-dependency"
      and .nodeSeed.sourceSha == $seedSourceSha and .nodeSeed.sourceRevCount == $seedSourceRevCount
      and .nodeSeed.lockHash == $seedLockHash and .nodeSeed.keyId == $seedKeyId
      and .nodeSeed.signingKey == $seedSigningKey and .nodeSeed.roots == $seedRoots
      and .nodeSeed.archive.name == $seedArchiveName
      and .nodeSeed.archive.bytes == $seedArchiveBytes
      and .nodeSeed.archive.sha256 == $seedArchiveSha256
      and .nodeSeed.manifest.name == $seedManifestName
      and .nodeSeed.manifest.sha256 == $seedManifestSha256
      and any(.closure[]; .path == $outputPath)' \
    "$manifest_file" >/dev/null || fail "Artifact manifest differs from trusted producer outputs."

  destination_store="local?root=$store_root&state=$state_root&require-sigs=true"
  import_started="$(date +%s)"
  nix copy --from "file://$cache_dir" --to "$destination_store" \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$NIX_RELEASE_PUBLIC_KEY" "$expected_output" "$expected_manifest"
  nix store copy-sigs --store "$destination_store" --substituter "file://$cache_dir" \
    --recursive --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$NIX_RELEASE_PUBLIC_KEY" "$expected_output"
  import_seconds="$(( $(date +%s) - import_started ))"
  verify_started="$(date +%s)"
  nix store verify --store "$destination_store" --recursive --sigs-needed 1 \
    --option builders '' --option substituters '' --option require-sigs true \
    --option trusted-public-keys "$NIX_RELEASE_PUBLIC_KEY" "$expected_output"
  closure_json="$(nix path-info --store "$destination_store" --json --recursive \
    --option builders '' --option substituters '' --option trusted-public-keys "$NIX_RELEASE_PUBLIC_KEY" \
    "$expected_output" | jq -cS 'to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}) | sort_by(.path)')"
  jq -e --argjson imported "$closure_json" '.closure == $imported' "$manifest_file" >/dev/null \
    || fail "Imported closure path/NAR metadata differs from the producer-pinned manifest."
  nix store cat --store "$destination_store" "$expected_manifest" > "$RUNNER_TEMP/paseo-nix-imported-manifest.json"
  cmp -s "$manifest_file" "$RUNNER_TEMP/paseo-nix-imported-manifest.json" \
    || fail "Imported manifest content differs from the downloaded independently-pinned metadata artifact."
  verify_seconds="$(( $(date +%s) - verify_started ))"

  {
    echo "### Fresh-runner Nix closure verification"
    echo "- Source SHA: \`$source_sha\`; fork version: $fork_version; flake.lock SHA-256: \`$expected_lock\`."
    echo "- Downloaded artifact manifest matched producer job SHA-256: \`$expected_manifest_sha\`."
    echo "- Imported exact output \`$expected_output\` into a separate rooted store with builders/substituters disabled."
    echo "- Extraction: ${extraction_seconds}s; import: ${import_seconds}s; signature and closure verification: ${verify_seconds}s."
    echo "- Nix signature verification required one trusted signature; imported closure paths, NAR hashes, and sizes matched the producer manifest."
    echo "- The same-run manifest SHA is pinned by the producer job output; this is not standalone manifest authentication."
    echo "- Rooted store: \`$store_root\`; no application launch was attempted."
  } >> "$GITHUB_STEP_SUMMARY"
}

case "${1:-}" in
  prepare) prepare ;;
  build) build ;;
  export-signed-closure) export_signed_closure ;;
  verify-import) verify_import ;;
  *) fail "Usage: $0 {prepare|build|export-signed-closure|verify-import}" ;;
esac
