import type { NativeShortcutPolicy } from "@/keyboard/native-shortcut-policy";

// Web reads keys from DOM events; these are the native module's no-op stand-ins.

interface Subscription {
  remove: () => void;
}

const noSubscription: Subscription = { remove: () => {} };

export function setHardwareKeyboardSubmitEnabled(_enabled: boolean) {}

export function addHardwareKeyboardSubmitListener(_handler: () => void): Subscription {
  return noSubscription;
}

export function setNativeShortcutPolicy(_policy: NativeShortcutPolicy) {}

export function addNativeShortcutKeyListener(_handler: (payload: unknown) => void): Subscription {
  return noSubscription;
}

export function useHasHardwareKeyboard(): boolean {
  return false;
}
