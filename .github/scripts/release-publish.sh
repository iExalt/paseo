#!/usr/bin/env bash
# GitHub release steps for release.yml.
#            expected assets, re-download and re-hash them
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


check_assets() {
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
  echo "release_id=$id" >> "$GITHUB_OUTPUT"
  echo "Draft release $id ($TAG)"

  while IFS= read -r file; do
      --data-binary "@$ASSETS/$file" \
      "https://uploads.github.com/repos/$repo/releases/$id/assets?name=$file" > /dev/null
    echo "Uploaded $file"

  # Re-download every asset from the release and compare it with the signed bytes.
  local listing="$RUNNER_TEMP/release-assets.json"
  request "$api/releases/$id/assets?per_page=100" > "$listing"
  while IFS= read -r file; do
    asset_id="$(jq -er --arg name "$file" '.[] | select(.name == $name and .state == "uploaded") | .id' "$listing")"
    [[ "$(request --location --header "Accept: application/octet-stream" "$api/releases/assets/$asset_id" | shasum -a 256 | cut -d' ' -f1)" \
      == "$(shasum -a 256 "$ASSETS/$file" | cut -d' ' -f1)" ]] || fail "Downloaded $file differs from the signed bytes."
    echo "Verified $file"
}

publish() {
  [[ "$PUBLISH" == true && "$TAG" == "paseo-v$VERSION" ]] || fail "Refusing to publish $TAG."
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
