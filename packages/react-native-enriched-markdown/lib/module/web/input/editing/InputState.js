"use strict";

import { isHeading } from "../model/blocks.js";
// The link the state describes: the one covering the selection's first
// character, or, for a caret, the one it sits inside or immediately after.
//
// `rangeOfType` is end-exclusive, so a caret at a link's tail - where typing
// the link's last character leaves it - has to look one position back. Both
// natives do that retry (`ENRMLinkCoordinator`'s `linkForSelection:` falls
// back to `location - 1`, and Android routes through the same call); without
// it a shared link toolbar pre-fills on native and comes up empty on web.
function linkForSelection(formattingStore, selection) {
  const atStart = formattingStore.rangeOfType('link', selection.start);
  if (atStart !== null || selection.start !== selection.end) {
    return atStart;
  }
  return selection.start === 0 ? null : formattingStore.rangeOfType('link', selection.start - 1);
}

// A style is active over a selection when it covers the whole of it, and at a
// caret when it is effectively active there.
function inlineStates(formattingStore, typing, selection, text) {
  const active = type => selection.start === selection.end ? typing.isEffectiveStyleActive(type, selection.start) : formattingStore.isStyleFullyActive(type, selection.start, selection.end, text);
  const link = linkForSelection(formattingStore, selection);
  return {
    bold: {
      isActive: active('strong')
    },
    italic: {
      isActive: active('em')
    },
    underline: {
      isActive: active('underline')
    },
    strikethrough: {
      isActive: active('strikethrough')
    },
    spoiler: {
      isActive: active('spoiler')
    },
    // A caret reads its link off the same lookup the destination comes from,
    // so the two agree; a selection keeps the whole-coverage rule. With no
    // link the destination is `""`, as for a link with an empty url.
    link: {
      isActive: selection.start === selection.end ? link !== null : active('link'),
      destination: link?.url ?? ''
    }
  };
}
export function buildInputState(formattingStore, blockStore, typing, selection, text) {
  const block = blockStore.blockAt(selection.start, text);
  const headingLevel = isHeading(block) ? block.level : 0;
  const unordered = block?.type === 'unordered-list-item';
  const ordered = block?.type === 'ordered-list-item';
  return {
    ...inlineStates(formattingStore, typing, selection, text),
    heading: {
      isActive: headingLevel > 0,
      level: headingLevel
    },
    unorderedList: {
      isActive: unordered,
      depth: unordered ? block.level : 0
    },
    orderedList: {
      isActive: ordered,
      depth: ordered ? block.level : 0
    }
  };
}

// `satisfies` makes the compiler reject a key missing from `InputState`, so a
// field added there cannot be skipped by the comparison and go unreported.
const INPUT_STATE_KEYS = Object.keys({
  bold: true,
  italic: true,
  underline: true,
  strikethrough: true,
  spoiler: true,
  link: true,
  heading: true,
  unorderedList: true,
  orderedList: true
});
export function sameInputState(a, b) {
  for (const key of INPUT_STATE_KEYS) {
    const before = a[key];
    const after = b[key];
    for (const field in before) {
      if (before[field] !== after[field]) {
        return false;
      }
    }
  }
  return true;
}

// A copy sharing nothing with `state`, for handing to a consumer.
export function copyInputState(state) {
  const copy = {};
  for (const key of INPUT_STATE_KEYS) {
    copy[key] = {
      ...state[key]
    };
  }
  return copy;
}
//# sourceMappingURL=InputState.js.map
