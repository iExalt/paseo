import { normalizeDomTerminalKey } from "@/utils/terminal-keys";

export type NativeTerminalKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export interface NativeTerminalKeyEvent {
  /** DOM `key`: a named key such as `Enter`, or the character the key types. */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type NativeTerminalKeyHandler = (event: NativeTerminalKeyEvent) => Promise<void> | void;

export function resolveNativeTerminalKey(key: string): NativeTerminalKey | null {
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return key;
    default:
      return null;
  }
}

/**
 * Physical keyboards report the DOM `code`. UIKit leaves `key` as a sentinel
 * for Left/Right, so the code is the only reliable identifier there.
 */
export function resolveHardwareTerminalKey(input: {
  key?: string;
  code?: string;
}): NativeTerminalKey | null {
  return resolveNativeTerminalKey(input.code ?? "") ?? resolveNativeTerminalKey(input.key ?? "");
}

export function createNativeTerminalKeyEvent(
  key: NativeTerminalKey,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): NativeTerminalKeyEvent {
  return {
    key,
    ctrl: modifiers.ctrl ?? false,
    shift: modifiers.shift ?? false,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
  };
}

/**
 * Validates a hardware key the PaseoHardwareKeyboard module captured for the
 * focused native terminal (Android only). Keys the terminal cannot encode are
 * dropped.
 */
export function parseNativeTerminalKeyEvent(payload: unknown): NativeTerminalKeyEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { key, altKey, ctrlKey, metaKey, shiftKey } = payload as Record<string, unknown>;
  if (typeof key !== "string") return null;
  if (
    typeof altKey !== "boolean" ||
    typeof ctrlKey !== "boolean" ||
    typeof metaKey !== "boolean" ||
    typeof shiftKey !== "boolean"
  ) {
    return null;
  }
  const terminalKey = normalizeDomTerminalKey(key);
  if (terminalKey === null) return null;
  return { key: terminalKey, ctrl: ctrlKey, shift: shiftKey, alt: altKey, meta: metaKey };
}

export function forwardNativeTerminalKey(input: {
  event: NativeTerminalKeyEvent;
  onTerminalKey?: NativeTerminalKeyHandler;
}): void {
  input.onTerminalKey?.(input.event);
}
