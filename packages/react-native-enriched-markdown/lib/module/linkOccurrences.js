"use strict";

import { useLayoutEffect, useRef } from 'react';
function sameLinks(a, b) {
  return a.length === b.length && a.every((link, index) => {
    const other = b[index];
    return link.url === other.url && link.label === other.label && link.title === other.title;
  });
}

/**
 * Reports the collected links to `onLinksChange`, shared by the native and web
 * implementations. It runs in a layout effect, so a state update the handler
 * makes lands before the frame is drawn, and only when the links differ from
 * the last report: a streaming tick that adds no link reports nothing. The
 * handler is read like an event handler; a new function does not report again.
 * Nothing is reported while `collected` is false: the links are not known yet,
 * which is not the same as a document with none.
 */
export function useLinksChange(links, onLinksChange, collected) {
  const handlerRef = useRef(onLinksChange);
  useLayoutEffect(() => {
    handlerRef.current = onLinksChange;
  });
  const reportedRef = useRef(undefined);
  const enabled = collected && onLinksChange != null;
  useLayoutEffect(() => {
    if (!enabled) {
      reportedRef.current = undefined;
      return;
    }
    const reported = reportedRef.current;
    if (reported && sameLinks(reported, links)) return;
    reportedRef.current = links;
    handlerRef.current?.([...links]);
  }, [links, enabled]);
}
//# sourceMappingURL=linkOccurrences.js.map
