import { create } from "zustand";

interface ChatFindHighlight {
  messageId: string;
  query: string;
  /** Occurrence within the message, counted in rendered order. */
  occurrence: number;
}

const useHighlightStore = create<{ highlight: ChatFindHighlight | null }>(() => ({
  highlight: null,
}));

export function setChatFindHighlight(highlight: ChatFindHighlight | null): void {
  useHighlightStore.setState({ highlight });
}

/**
 * The highlight for one message, or null. Only the message whose highlight changes
 * re-renders when find moves.
 */
export function useChatFindHighlight(messageId: string): ChatFindHighlight | null {
  return useHighlightStore((state) =>
    state.highlight?.messageId === messageId ? state.highlight : null,
  );
}
