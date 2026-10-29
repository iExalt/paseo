#!/usr/bin/env bash
# GitHub release steps for release.yml.
#   draft:   find TAG's draft (release-please makes one) or create it, upload the
#            expected assets, re-download and re-hash them
#   publish: publish the verified draft as latest; TAG must point at SOURCE_SHA
# Reads GH_TOKEN, GITHUB_REPOSITORY, VERSION, SOURCE_SHA, TAG, ASSETS, PUBLISH, RELEASE_ID.
set -euo pipefail
repo="${GITHUB_REPOSITORY:?}"
api="https://api.github.com/repos/$repo"

fail() {
  echo "::error::$*" >&2
  exit 1
}

headers="$RUNNER_TEMP/github-api-headers"
(umask 077 && printf 'Authorization: Bearer %s\nX-GitHub-Api-Version: 2022-11-28\n' "${GH_TOKEN:?}" > "$headers")
trap 'rm -f "$headers"' EXIT
request() { curl --fail-with-body --silent --show-error --retry 3 --header "@$headers" "$@"; }
# Calls that change the release retry only a 403/429 rejection, which changed
# nothing; a retried 5xx that had succeeded would duplicate the release or asset.
# Failures print GitHub's response, which names rate limits and permission errors.
mutate() {
  local body="$RUNNER_TEMP/github-mutate-body" response="$RUNNER_TEMP/github-mutate-headers"
  local code attempt
  for attempt in 1 2; do
    code="$(curl --silent --show-error --header "@$headers" --dump-header "$response" \
      --output "$body" --write-out '%{http_code}' "$@")" || code=000
    if [[ "$code" == 2?? ]]; then
      cat "$body"
      return 0
    fi
    echo "::warning::GitHub returned HTTP $code (attempt $attempt): $(head -c 2000 "$body" 2>/dev/null)" >&2
    grep -iE '^(retry-after|x-ratelimit-[a-z]+|x-github-request-id):' "$response" >&2 || true
    [[ "$attempt" == 1 && ( "$code" == 403 || "$code" == 429 ) ]] || return 1
    sleep "$(awk -F': *' 'tolower($1) == "retry-after" { delay = $2 + 0 } END { print (delay > 0 ? delay : 60) }' "$response")"
  done
}

expected_assets() {
  {
    printf '%s\n' paseo-release-manifest.json paseo-release-manifest.sig \
      "paseo-$VERSION-macos-arm64-nix-desktop.tar" "paseo-$VERSION-macos-arm64-nix-desktop.json" \
      "paseo-$VERSION-macos-arm64-nix-desktop.index.json" \
      "paseo-$VERSION-android-arm64.apk" "paseo-$VERSION-android-arm64.apk.gz" \
      "paseo-$VERSION-android-cache-pin.json"
    # The desktop deltas the unsigned index lists: none up to DELTA_BASE_RELEASES
    # (release-mac-index.mjs). A duplicate or unlisted delta fails the set check.
    jq -r '.deltas[].asset' "$ASSETS/paseo-$VERSION-macos-arm64-nix-desktop.index.json"
    # The APK deltas release-android-delta.mjs made: any set of correctly named ones.
    find "$ASSETS" -mindepth 1 -maxdepth 1 -name "paseo-$VERSION-android-arm64.apk.delta-from-*" -exec basename {} \; \
      | grep -E "^paseo-${VERSION//./\\.}-android-arm64\\.apk\\.delta-from-[0-9]+\\.[0-9]+\\.[0-9]+\\.zst$" || true
  } | sort
}

check_assets() {
  local delta_name="^paseo-${VERSION//./\\.}-macos-arm64-nix-desktop\\.delta-from-[0-9]+\\.[0-9]+\\.[0-9]+\\.zst$"
  jq -e --arg pattern "$delta_name" 'all(.deltas[].asset; test($pattern))' \
    "$ASSETS/paseo-$VERSION-macos-arm64-nix-desktop.index.json" > /dev/null || fail "Unexpected delta asset name."
  [[ "$(find "$ASSETS" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort)" == "$(expected_assets)" ]] || fail "Unexpected release asset set."
}

draft() {
  local name id file asset_id
  check_assets
  if [[ "$PUBLISH" == true ]]; then
    [[ "$TAG" == "paseo-v$VERSION" ]] || fail "Publish tag must be paseo-v$VERSION."
    name="Paseo $VERSION"
  else
    [[ "$TAG" == paseo-dryrun-* ]] || fail "Dry runs must use a paseo-dryrun- tag."
    name="Dry run: Paseo $VERSION ($SOURCE_SHA)"
  fi
  # The releases/tags endpoint omits drafts, so search the listing. A rerun after a
  # failed upload reuses the draft and replaces its assets.
  id="$(request "$api/releases?per_page=100" | jq -r --arg tag "$TAG" '[.[] | select(.tag_name == $tag)] | first | if . == null then "" elif .draft then .id else "published" end')"
  [[ "$id" != published ]] || fail "$TAG is already published."
  if [[ -n "$id" ]]; then
    request "$api/releases/$id/assets?per_page=100" | jq -r '.[].id' | while IFS= read -r asset_id; do
      request --request DELETE "$api/releases/assets/$asset_id" > /dev/null
    done
  else
    # A file, not stdin, so mutate() can resend it on a retry.
    local payload="$RUNNER_TEMP/release-create.json"
    jq -n --arg tag "$TAG" --arg sha "$SOURCE_SHA" --arg name "$name" \
      --rawfile body "$RUNNER_TEMP/release-notes.md" \
      '{tag_name: $tag, target_commitish: $sha, name: $name, body: $body,
        draft: true, prerelease: false, make_latest: "false"}' > "$payload"
    id="$(mutate --request POST --data-binary "@$payload" "$api/releases" | jq -er .id)"
  fi
  echo "release_id=$id" >> "$GITHUB_OUTPUT"
  echo "Draft release $id ($TAG)"

  while IFS= read -r file; do
    mutate --request POST --header "Content-Type: application/octet-stream" \
      --data-binary "@$ASSETS/$file" \
      "https://uploads.github.com/repos/$repo/releases/$id/assets?name=$file" > /dev/null
    echo "Uploaded $file"
  done < <(expected_assets)

  # Re-download every asset from the release and compare it with the signed bytes.
  local listing="$RUNNER_TEMP/release-assets.json"
  request "$api/releases/$id/assets?per_page=100" > "$listing"
  [[ "$(jq -r '.[].name' "$listing" | sort)" == "$(expected_assets)" ]] || fail "Release assets differ from the upload set."
  while IFS= read -r file; do
    asset_id="$(jq -er --arg name "$file" '.[] | select(.name == $name and .state == "uploaded") | .id' "$listing")"
    [[ "$(request --location --header "Accept: application/octet-stream" "$api/releases/assets/$asset_id" | shasum -a 256 | cut -d' ' -f1)" \
      == "$(shasum -a 256 "$ASSETS/$file" | cut -d' ' -f1)" ]] || fail "Downloaded $file differs from the signed bytes."
    echo "Verified $file"
  done < <(expected_assets)
}

publish() {
  [[ "$PUBLISH" == true && "$TAG" == "paseo-v$VERSION" ]] || fail "Refusing to publish $TAG."
  local payload="$RUNNER_TEMP/release-publish.json"
  jq -n --arg tag "$TAG" --arg sha "$SOURCE_SHA" --arg name "Paseo $VERSION" \
    '{tag_name: $tag, target_commitish: $sha, name: $name, draft: false, prerelease: false, make_latest: "true"}' > "$payload"
  mutate --request PATCH --data-binary "@$payload" "$api/releases/${RELEASE_ID:?}" > /dev/null \
    || fail "GitHub refused to publish $TAG; see the response above."
  [[ "$(request "$api/commits/$TAG" | jq -er .sha)" == "$SOURCE_SHA" ]] || fail "$TAG does not point at $SOURCE_SHA."
  [[ "$(request "$api/releases/latest" | jq -er .tag_name)" == "$TAG" ]] || fail "$TAG is not the latest release."
  echo "Published $TAG at $SOURCE_SHA as the latest release."
}

case "${1:-}" in
  check-assets) check_assets ;;
  draft) draft ;;
  publish) publish ;;
  *) fail "Usage: $0 {check-assets|draft|publish}" ;;
esac
