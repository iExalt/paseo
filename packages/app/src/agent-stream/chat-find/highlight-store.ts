import { useMemo } from "react";
import { create } from "zustand";

/** The occurrence chat find has selected, as the stream item that draws it. */
export interface ChatFindHighlight {
  messageId: string;
  itemId: string;
  query: string;
  /** Occurrence within the item, counted in rendered order. */
  index: number;
}

const useHighlightStore = create<{ highlight: ChatFindHighlight | null }>(() => ({
  highlight: null,
}));

export function setChatFindHighlight(highlight: ChatFindHighlight | null): void {
  useHighlightStore.setState({ highlight });
}

/** Whether find selected this message. Only the rows whose answer changes re-render. */
export function useChatFindMessageSelected(messageId: string): boolean {
  return useHighlightStore((state) => state.highlight?.messageId === messageId);
}

/** The selected occurrence if this item draws it, else null. */
export function useChatFindItemHighlight(
  itemId: string | undefined,
): { query: string; index: number } | null {
  const query = useHighlightStore((state) =>
    itemId !== undefined && state.highlight?.itemId === itemId ? state.highlight.query : null,
  );
  const index = useHighlightStore((state) =>
    itemId !== undefined && state.highlight?.itemId === itemId ? state.highlight.index : -1,
  );
  return useMemo(() => (query === null ? null : { query, index }), [index, query]);
}
