import { useSyncExternalStore } from "react";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import type { NativeShortcutPolicy } from "@/keyboard/native-shortcut-policy";

type HardwareKeyboardEvent =
  | "onHardwareKeyboardSubmit"
  | "onShortcutKey"
  | "onHardwareKeyboardChange"
  | "onTerminalKey";

interface PaseoHardwareKeyboardModule {
  setHardwareKeyboardSubmitEnabled(enabled: boolean): void;
  setShortcutPolicy(policyJson: string): void;
  hasHardwareKeyboard(): boolean;
  // Optional: Android detects the terminal view by nativeID, and older iOS
  // dev clients predate the capture flag.
  setTerminalKeyCaptureActive?(active: boolean): void;
  addListener(
    eventName: HardwareKeyboardEvent,
    handler: (payload: Record<string, unknown>) => void,
  ): EventSubscription;
}

// Optional so a build without the module (Expo Go, an older dev client) runs
// without shortcuts instead of crashing at import.
const module = requireOptionalNativeModule<PaseoHardwareKeyboardModule>("PaseoHardwareKeyboard");

const noSubscription: EventSubscription = { remove: () => {} };

export function setHardwareKeyboardSubmitEnabled(enabled: boolean) {
  module?.setHardwareKeyboardSubmitEnabled(enabled);
}

export function addHardwareKeyboardSubmitListener(handler: () => void): EventSubscription {
  return module?.addListener("onHardwareKeyboardSubmit", () => handler()) ?? noSubscription;
}

export function setNativeShortcutPolicy(policy: NativeShortcutPolicy) {
  module?.setShortcutPolicy(JSON.stringify(policy));
}

export function addNativeShortcutKeyListener(
  handler: (payload: unknown) => void,
): EventSubscription {
  return module?.addListener("onShortcutKey", handler) ?? noSubscription;
}

/** Hardware keys captured for the focused native terminal input. */
export function addNativeTerminalKeyListener(
  handler: (payload: unknown) => void,
): EventSubscription {
  return module?.addListener("onTerminalKey", handler) ?? noSubscription;
}

/** Switches iOS terminal key capture; Android ignores it and detects the view by nativeID. */
export function setNativeTerminalKeyCaptureActive(active: boolean) {
  module?.setTerminalKeyCaptureActive?.(active);
}

let hasHardwareKeyboard: boolean | null = null;

function readHasHardwareKeyboard(): boolean {
  if (hasHardwareKeyboard === null) {
    hasHardwareKeyboard = module?.hasHardwareKeyboard() ?? false;
  }
  return hasHardwareKeyboard;
}

function subscribeHasHardwareKeyboard(onChange: () => void): () => void {
  // Changes are only heard while subscribed; re-read in case one was missed.
  hasHardwareKeyboard = null;
  const subscription = module?.addListener("onHardwareKeyboardChange", (payload) => {
    hasHardwareKeyboard = payload.present === true;
    onChange();
  });
  return () => subscription?.remove();
}

/** Whether a hardware keyboard is attached; updates as one connects or disconnects. */
export function useHasHardwareKeyboard(): boolean {
  return useSyncExternalStore(subscribeHasHardwareKeyboard, readHasHardwareKeyboard);
}
