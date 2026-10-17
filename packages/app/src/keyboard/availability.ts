import { useSyncExternalStore } from "react";
import { hardwareKeyboardPresence } from "./internal/presence";
export function useHardwareKeyboardPresent(): boolean {
  return useSyncExternalStore(
    hardwareKeyboardPresence.subscribe,
    hardwareKeyboardPresence.getSnapshot,
    () => false,
  );
}

/** Settings follow the shared observed keyboard capability. */
export const useKeyboardShortcutsAvailable = useHardwareKeyboardPresent;
