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

/** The selected occurrence's root Text, which can measure where on screen it sits. */
export interface ChatFindAnchor {
  itemId: string;
  index: number;
  measure(): Promise<{ top: number; height: number } | null>;
}

// Read only when reveal scrolls, so nothing renders from it.
let currentAnchor: ChatFindAnchor | null = null;

export function setChatFindAnchor(anchor: ChatFindAnchor): () => void {
  currentAnchor = anchor;
  return () => {
    if (currentAnchor === anchor) currentAnchor = null;
  };
}

export function getChatFindAnchor(itemId: string, index: number): ChatFindAnchor | null {
  return currentAnchor?.itemId === itemId && currentAnchor.index === index ? currentAnchor : null;
}
