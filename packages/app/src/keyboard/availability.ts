import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHasHardwareKeyboard } from "@/native/hardware-keyboard";

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

export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  const hasHardwareKeyboard = useHasHardwareKeyboard();
  return keyboardShortcutsAvailable({ isNative, isCompact, hasHardwareKeyboard });
}
