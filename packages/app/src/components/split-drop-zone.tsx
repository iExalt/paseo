import type { SplitDropZoneProps } from "@/components/split-drop-zone-position";

// Native fallback: drag-to-split is web-only (see split-dnd.tsx), so panes have
// no drop target. Web uses split-drop-zone.web.tsx.
export function SplitDropZone(_props: SplitDropZoneProps): null {
  return null;
}
