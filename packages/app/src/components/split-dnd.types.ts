import type { ReactNode } from "react";
import type { DragEndEvent, DragMoveEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";

export interface SplitDndProviderProps {
  children: ReactNode;
  /** Rendered under the pointer while a tab is dragged. */
  overlay: ReactNode;
  onDragStart: (event: DragStartEvent) => void;
  onDragMove: (event: DragMoveEvent) => void;
  onDragOver: (event: DragOverEvent) => void;
  onDragCancel: () => void;
  onDragEnd: (event: DragEndEvent) => void;
}
