import { useEffect, useMemo, useState } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { useStableEvent } from "@/hooks/use-stable-event";
import { selectAllSource } from "./hit-testing";
import {
  buildNativeSelectionGeometry,
  nativeSelectedText,
  selectionForScope,
  type NativeDiffSelectionScope,
  type NativeSelectionGeometry,
  type ScopedNativeSelection,
} from "./native-selection";
import type { DiffCharacterPosition, DiffDocumentModel, DiffSelection } from "./types";

export interface NativeDiffSelectionController {
  selection: DiffSelection | null;
  /** Document-space highlight rectangles; null when nothing is selected. */
  geometry: NativeSelectionGeometry | null;
  /** Mirrors `selection !== null` for gesture worklets. */
  active: SharedValue<boolean>;
  setSelection: (next: DiffSelection | null) => void;
  clearSelection: () => void;
  /** Selects one split side (the preferred position's, else new) or the whole unified diff. */
  selectAll: (preferredPosition?: DiffCharacterPosition) => DiffSelection | null;
  /** Source text of the current selection without line numbers. */
  getSelectedText: () => string;
}

export function useNativeDiffSelection(
  model: DiffDocumentModel,
  scope: NativeDiffSelectionScope,
): NativeDiffSelectionController {
  const [state, setState] = useState<ScopedNativeSelection | null>(null);
  const selection = selectionForScope(state, scope);
  const active = useSharedValue(false);
  useEffect(() => {
    active.value = selection !== null;
  }, [active, selection]);
  const geometry = useMemo(
    () => buildNativeSelectionGeometry(model, selection),
    [model, selection],
  );
  const setSelection = useStableEvent((next: DiffSelection | null) => {
    setState(next ? { scope, selection: next } : null);
  });
  const clearSelection = useStableEvent(() => setState(null));
  const selectAll = useStableEvent((preferredPosition?: DiffCharacterPosition) => {
    const next = selectAllSource(model, preferredPosition ?? selection?.focus);
    setSelection(next);
    return next;
  });
  const getSelectedText = useStableEvent(() => nativeSelectedText(model, selection));
  return useMemo(
    () => ({
      selection,
      geometry,
      active,
      setSelection,
      clearSelection,
      selectAll,
      getSelectedText,
    }),
    [active, clearSelection, geometry, getSelectedText, selectAll, selection, setSelection],
  );
}
