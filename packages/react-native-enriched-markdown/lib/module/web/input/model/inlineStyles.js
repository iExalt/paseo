"use strict";

// Canonical order for a run's style list, so equal style sets compare equal.
// It has to be total: a style missing here is filtered out of every run, so
// the union is derived from it.
export const INPUT_STYLE_TYPES = ['strong', 'em', 'underline', 'strikethrough', 'link', 'spoiler'];

// A style that can be armed at the caret. Not a link: a pending style has
// nowhere to keep a url, and `FormattingStore.addRange` takes the new range's
// url, so a pending `link` would strip the url from whatever it merged with.
// Android encodes the same exclusion when it seeds its pending styles.

export const TYPING_ATTRIBUTE_STYLES = ['strong', 'em', 'underline', 'strikethrough', 'spoiler'];
export function createFormattingRange(type, start, end, url) {
  return url === undefined ? {
    type,
    start,
    end
  } : {
    type,
    start,
    end,
    url
  };
}
//# sourceMappingURL=inlineStyles.js.map
