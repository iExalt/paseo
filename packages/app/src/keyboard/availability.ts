import { useSyncExternalStore } from "react";
import { hardwareKeyboardPresence } from "./internal/presence";
export function useHardwareKeyboardPresent(): boolean {
  return useSyncExternalStore(
    hardwareKeyboardPresence.subscribe,
    hardwareKeyboardPresence.getSnapshot,
    () => false,
  );
}

interface KeyboardShortcutEnvironment {
  isNative: boolean;
  isCompact: boolean;
  hasHardwareKeyboard: boolean;
}

/** Wide layouts get shortcuts; native ones only while a hardware keyboard is attached. */
export function keyboardShortcutsAvailable({
  isNative: native,
  isCompact,
  hasHardwareKeyboard,
}: KeyboardShortcutEnvironment): boolean {
  return !isCompact && (!native || hasHardwareKeyboard);
}

export const useKeyboardShortcutsAvailable = useHardwareKeyboardPresent;
