"use strict";

import { useMemo } from 'react';
import { useResolvedImageSources } from "../imageSources.js";

/** One entry per image occurrence, as the native component takes it. */

const NO_HEADERS = [];
function toNativeHeaders(headers) {
  if (!headers) return NO_HEADERS;
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * The `imageSources` prop for the collected occurrences: resolved sources as
 * given, pending ones as empty uris, and no entry for images that keep their
 * Markdown URL. See `useResolvedImageSources` for the resolution rules.
 */
export function useImageSources(occurrences, resolver, enabled) {
  const resolved = useResolvedImageSources(occurrences, resolver, enabled);
  return useMemo(() => {
    if (!resolved) return undefined;
    const result = [];
    for (const [id, resolution] of resolved) {
      if (resolution.state === 'markdown') continue;
      if (resolution.state === 'pending') {
        result.push({
          id,
          uri: '',
          headers: NO_HEADERS
        });
        continue;
      }
      const {
        uri,
        headers
      } = resolution.source;
      result.push({
        id,
        uri: typeof uri === 'string' ? uri : '',
        headers: toNativeHeaders(headers)
      });
    }
    return result;
  }, [resolved]);
}
//# sourceMappingURL=useImageSources.js.map
