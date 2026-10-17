import type { ReactNode } from "react";
import type { SplitDndProviderProps } from "@/components/split-dnd.types";

/**
 * Native fallback for the SplitContainer drag-and-drop context: renders the panes
 * with no drag support. Drag-to-split and tab drag are web-only because touch
 * drags compete with scrolling and swipe gestures; native splits panes and moves
 * tabs from menus instead. Web uses split-dnd.web.tsx (dnd-kit, DOM-only).
 */
export function SplitDndProvider({ children }: SplitDndProviderProps): ReactNode {
  return children;
}
