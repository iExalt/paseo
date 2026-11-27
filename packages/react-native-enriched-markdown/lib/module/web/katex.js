"use strict";

// `undefined` until the first lookup; `null` when KaTeX is not installed.
let katexInstance;

/** Lazily loads KaTeX. Returns null if not installed. */
export function loadKaTeX() {
  if (katexInstance === undefined) {
    katexInstance = null;
    try {
      const mod = require('katex');
      const candidate = mod?.default ?? mod;
      if (typeof candidate?.renderToString === 'function') {
        katexInstance = candidate;
      }
    } catch {
      // katex not installed — math rendering will be skipped
    }
  }
  return katexInstance;
}
//# sourceMappingURL=katex.js.map
