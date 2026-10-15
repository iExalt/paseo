#!/usr/bin/env bash
# GitHub release steps for release.yml.
#   draft:   create a draft release, upload the five assets, re-download and re-hash them
#   publish: publish the verified draft as latest, creating TAG at SOURCE_SHA
#   discard: delete RELEASE_ID if it is still a draft
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
# Creating calls retry only a 403/429 rejection, which created nothing; a retried
# 5xx that had succeeded would duplicate the release or asset. Failures print
# GitHub's response, which names rate limits and permission errors.
create() {
  local body="$RUNNER_TEMP/github-create-body" response="$RUNNER_TEMP/github-create-headers"
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
    sleep "$(awk -F': *' 'tolower($1) == "retry-after" { delay = $2 + 0 } END { print delay > 0 ? delay : 60 }' "$response")"
  done
}

expected_assets() {
  printf '%s\n' paseo-release-manifest.json paseo-release-manifest.sig \
    "paseo-$VERSION-macos-arm64-nix-desktop.tar" "paseo-$VERSION-macos-arm64-nix-desktop.json" \
    "paseo-$VERSION-android-arm64.apk" | sort
}

draft() {
  local name id file asset_id
  [[ "$(find "$ASSETS" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort)" == "$(expected_assets)" ]] || fail "Unexpected release asset set."
  if [[ "$PUBLISH" == true ]]; then
    [[ "$TAG" == "paseo-v$VERSION" ]] || fail "Publish tag must be paseo-v$VERSION."
    name="Paseo $VERSION"
  else
    [[ "$TAG" == paseo-dryrun-* ]] || fail "Dry runs must use a paseo-dryrun- tag."
    name="Dry run: Paseo $VERSION ($SOURCE_SHA)"
  fi
  id="$(jq -n --arg tag "$TAG" --arg sha "$SOURCE_SHA" --arg name "$name" \
    --rawfile body "$RUNNER_TEMP/release-notes.md" \
    '{tag_name: $tag, target_commitish: $sha, name: $name, body: $body,
      draft: true, prerelease: false, make_latest: "false"}' \
    | create --request POST --data-binary @- "$api/releases" | jq -er .id)"
  echo "release_id=$id" >> "$GITHUB_OUTPUT"
  echo "Draft release $id ($TAG)"

  while IFS= read -r file; do
    create --request POST --header "Content-Type: application/octet-stream" \
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
  jq -n --arg tag "$TAG" --arg sha "$SOURCE_SHA" \
    '{tag_name: $tag, target_commitish: $sha, draft: false, prerelease: false, make_latest: "true"}' \
    | request --request PATCH --data-binary @- "$api/releases/${RELEASE_ID:?}" > /dev/null
  [[ "$(request "$api/commits/$TAG" | jq -er .sha)" == "$SOURCE_SHA" ]] || fail "$TAG does not point at $SOURCE_SHA."
  [[ "$(request "$api/releases/latest" | jq -er .tag_name)" == "$TAG" ]] || fail "$TAG is not the latest release."
  echo "Published $TAG at $SOURCE_SHA as the latest release."
}

discard() {
  if [[ "$(request "$api/releases/${RELEASE_ID:?}" | jq -er .draft)" == true ]]; then
    request --request DELETE "$api/releases/$RELEASE_ID" > /dev/null
    echo "Deleted unpublished draft $RELEASE_ID."
  fi
}

case "${1:-}" in
  draft) draft ;;
  publish) publish ;;
  discard) discard ;;
  *) fail "Usage: $0 {draft|publish|discard}" ;;
esac
