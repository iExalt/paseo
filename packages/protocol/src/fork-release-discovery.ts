import { compareForkVersions, forkVersionFromTag } from "./fork-version.ts";
import { FORK_RELEASE_REPOSITORY } from "./release-manifest-v2.ts";

const PAGE_SIZE = 6;
const MAX_PAGES = 10;
const MAX_FALLBACKS = 5;
export type ReleaseMetadataFetcher = (url: string, what: string) => Promise<Uint8Array>;

/** Latest first, then at most five other stable tags; every candidate must pass the caller's verifier. */
export async function discoverVerifiedForkRelease<T>({
  resolveTag,
  fetchBytes,
  verifyTag,
}: {
  resolveTag: () => Promise<string>;
  fetchBytes: ReleaseMetadataFetcher;
  verifyTag: (tag: string) => Promise<T>;
}): Promise<T> {
  let latestTag: string | undefined;
  let lastError: unknown;
  try {
    const tag = await resolveTag();
    if (forkVersionFromTag(tag) === null)
      throw new Error("Latest release is not a stable fork tag.");
    latestTag = tag;
    return await verifyTag(tag);
  } catch (error) {
    lastError = error;
  }

  const tags = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const bytes = await fetchBytes(
      `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=${PAGE_SIZE}&page=${page}`,
      "the fallback release list",
    );
    const releases: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list.");
    for (const release of releases) {
      if (
        release &&
        release.draft === false &&
        release.prerelease === false &&
        release.tag_name !== latestTag &&
        forkVersionFromTag(release.tag_name) !== null
      ) {
        tags.add(release.tag_name);
        if (tags.size === MAX_FALLBACKS) break;
      }
    }
    if (tags.size === MAX_FALLBACKS || releases.length < PAGE_SIZE) break;
  }
  const candidates = [...tags].sort((a, b) =>
    compareForkVersions(forkVersionFromTag(b)!, forkVersionFromTag(a)!),
  );
  for (const tag of candidates) {
    try {
      return await verifyTag(tag);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
