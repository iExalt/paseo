import type { KeyboardFocusScope } from "@/keyboard/actions";
import {
  type ChordState,
  type KeyboardShortcutInput,
  matchesKeyboardShortcutContext,
  type ParsedShortcutBinding,
} from "@/keyboard/keyboard-shortcuts";
import type { KeyCombo } from "@/keyboard/shortcut-string";

/**
 * Native code decides synchronously, inside the platform key dispatch, whether a
 * hardware key belongs to Paseo. It cannot ask JS, so JS publishes the combos
 * that can match right now, split by whether a text input has focus. Native
 * mirrors `matchesCombo` in keyboard-shortcuts.ts against these entries; JS
 * still makes the final match with `resolveKeyboardShortcut`.
 */
export interface NativeShortcutCombo {
  /** DOM `code`, or `Digit` for any of Digit1-9 and Numpad1-9. */
  code: string;
  /** Lowercase DOM `key`; when absent the combo matches by `code` only. */
  key?: string;
  shiftedKey?: string;
  codeFallback?: true;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** `false` when a held-key repeat must not match. */
  repeat?: false;
  /**
   * Whether native swallows the key. When false, native reports the key and
   * still delivers it, as web does for bindings that leave the event alone.
   */
  consume: boolean;
}

export interface NativeShortcutPolicy {
  /** Combos that match even while a text input or WebView has focus. */
  always: NativeShortcutCombo[];
  /** Combos that match only while nothing is being typed into. */
  whenNotTyping: NativeShortcutCombo[];
}

/** Which kind of text input holds focus while native reports `typing`. */
export type NativeTypingScope = "message-input" | "terminal" | "editable";

export const EMPTY_NATIVE_SHORTCUT_POLICY: NativeShortcutPolicy = {
  always: [],
  whenNotTyping: [],
};

/** The focus scope web's `resolveKeyboardFocusScope` would report for a native key. */
export function resolveNativeKeyboardFocusScope(input: {
  typing: boolean;
  typingScope: NativeTypingScope;
  commandCenterOpen: boolean;
}): KeyboardFocusScope {
  if (input.commandCenterOpen) return "command-center";
  return input.typing ? input.typingScope : "other";
}

function hasCommandModifier(combo: NativeShortcutCombo): boolean {
  return combo.ctrl || combo.meta || combo.alt;
}

function toNativeCombo(
  combo: KeyCombo,
  binding: ParsedShortcutBinding,
  isMac: boolean,
  typing: boolean,
): NativeShortcutCombo {
  const native: NativeShortcutCombo = {
    code: combo.code,
    alt: combo.alt === true,
    ctrl: combo.ctrl === true || (!isMac && combo.mod === true),
    meta: combo.meta === true || (isMac && combo.mod === true),
    shift: combo.shift === true,
    consume: binding.preventDefault !== false,
  };
  if (combo.key !== undefined) native.key = combo.key;
  if (combo.shiftedKey !== undefined) native.shiftedKey = combo.shiftedKey;
  if (combo.codeFallback === true) native.codeFallback = true;
  if (combo.repeat === false) native.repeat = false;
  // Web only blocks a key after an action handles it. Native must decide before
  // JS runs, so a bare or Shift-only key reached while typing (Enter for
  // dictation, a chord's letter) is reported but still typed.
  if (typing && !hasCommandModifier(native)) native.consume = false;
  return native;
}

function comboIdentity(combo: NativeShortcutCombo): string {
  return [
    combo.code,
    combo.key ?? "",
    combo.shiftedKey ?? "",
    combo.codeFallback ?? "",
    combo.alt,
    combo.ctrl,
    combo.meta,
    combo.shift,
    combo.repeat ?? "",
  ].join(":");
}

function addCombo(target: Map<string, NativeShortcutCombo>, combo: NativeShortcutCombo): void {
  const id = comboIdentity(combo);
  const existing = target.get(id);
  if (existing) {
    existing.consume = existing.consume || combo.consume;
    return;
  }
  target.set(id, combo);
}

/**
 * Splits the bindings that can match at the current chord step into the two
 * sets native checks. A binding lands in `always` when web's own context rule
 * (`matchesKeyboardShortcutContext`) accepts it with focus in the current
 * typing scope; otherwise in `whenNotTyping` when web accepts it with focus
 * outside any text input.
 */
export function buildNativeShortcutPolicy(input: {
  bindings: readonly ParsedShortcutBinding[];
  chordState?: ChordState;
  isMac: boolean;
  commandCenterOpen: boolean;
  typingScope: NativeTypingScope;
}): NativeShortcutPolicy {
  const { bindings, isMac, commandCenterOpen, typingScope } = input;
  const contextFor = (typing: boolean) => ({
    isMac,
    isDesktop: false,
    commandCenterOpen,
    focusScope: resolveNativeKeyboardFocusScope({ typing, typingScope, commandCenterOpen }),
  });
  const typingContext = contextFor(true);
  const idleContext = contextFor(false);

  const step = input.chordState?.step ?? 0;
  const candidates =
    step > 0 && input.chordState
      ? input.chordState.candidateIndices
      : bindings.map((_, index) => index);

  const always = new Map<string, NativeShortcutCombo>();
  const whenNotTyping = new Map<string, NativeShortcutCombo>();
  for (const index of candidates) {
    const binding = bindings[index];
    const combo = binding?.parsedChord[step];
    if (!binding || !combo) continue;
    if (matchesKeyboardShortcutContext(binding.when, typingContext)) {
      addCombo(always, toNativeCombo(combo, binding, isMac, true));
    } else if (matchesKeyboardShortcutContext(binding.when, idleContext)) {
      addCombo(whenNotTyping, toNativeCombo(combo, binding, isMac, false));
    }
  }
  for (const id of always.keys()) {
    whenNotTyping.delete(id);
  }
  return { always: [...always.values()], whenNotTyping: [...whenNotTyping.values()] };
}

export interface NativeShortcutKeyEvent {
  event: KeyboardShortcutInput;
  /** A text input or WebView held focus when the key went down. */
  typing: boolean;
}

/** Validates a key event emitted by the PaseoHardwareKeyboard native module. */
export function parseNativeShortcutKeyEvent(payload: unknown): NativeShortcutKeyEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const { key, code, altKey, ctrlKey, metaKey, shiftKey, repeat, typing } = value;
  if (typeof key !== "string" || typeof code !== "string" || code === "") return null;
  if (
    typeof altKey !== "boolean" ||
    typeof ctrlKey !== "boolean" ||
    typeof metaKey !== "boolean" ||
    typeof shiftKey !== "boolean" ||
    typeof typing !== "boolean"
  ) {
    return null;
  }
  return {
    event: { key, code, altKey, ctrlKey, metaKey, shiftKey, repeat: repeat === true },
    typing,
  };
}
