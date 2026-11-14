import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  Platform,
  StyleSheet,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type TextStyle,
} from "react-native";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import {
  createNativeTerminalKeyEvent,
  resolveNativeTerminalKey,
  type NativeTerminalKey,
  type NativeTerminalKeyEvent,
} from "./terminal-key-events";
import { createHardwareTerminalKeyRouter } from "./hardware-terminal-keys";
import { claimNativeTypingScope } from "@/keyboard/native-typing-scope";
import {
  addNativeTerminalKeyListener,
  setNativeTerminalKeyCaptureActive,
} from "@/native/hardware-keyboard";
import { useStableEvent } from "@/hooks/use-stable-event";
import { nativeTerminalPerformanceNow } from "./terminal-performance";
import {
  traceTerminalInput,
  traceTerminalReset,
  type TerminalInputResetReason,
} from "./terminal-input-trace";

export const TERMINAL_INPUT_CONTEXT_MENU_HIDDEN = true;
export const TERMINAL_INPUT_HITBOX_SIZE = 1;
// Android's PaseoHardwareKeyboardModule.kt captures hardware terminal keys
// (Enter, Backspace, arrows, Ctrl and Alt chords) only while the focused view
// carries this nativeID. Keep the two in sync. iOS has no such view match (the
// first responder is an inner text view); it captures while the router has
// switched capture on.
export const TERMINAL_INPUT_NATIVE_ID = "paseo-native-terminal-input";

const hardwareTerminalKeys = createHardwareTerminalKeyRouter({
  addListener: addNativeTerminalKeyListener,
  setCaptureActive: setNativeTerminalKeyCaptureActive,
});

export interface TerminalTextInputChange {
  data: string;
  key?: NativeTerminalKey;
  shouldClear: boolean;
}

export interface TerminalTextInputState {
  receiveKeyPress: (key: string) => TerminalTextInputChange;
  receiveTextChange: (text: string) => TerminalTextInputChange;
  /** A captured hardware key is about to clear the native field; that clear must send nothing. */
  noteHardwareClear: () => void;
  reset: () => void;
}

/**
 * Where printable text comes from.
 *
 * - `keyThenDiff` sends printable keypresses and the part of each text change
 *   the key did not already cover. It assumes the key arrives first.
 * - `diff` sends printable text only from the text change and ignores
 *   printable keypresses. Android needs it: React Native's keypress emulation
 *   delivers the text change before the key for composing text and batched
 *   commits, so `keyThenDiff` sends the first character twice there.
 */
export type TerminalPrintableSource = "keyThenDiff" | "diff";

export interface TerminalTextInputStateOptions {
  printableSource?: TerminalPrintableSource;
  /** Milliseconds; injected by tests to step past the Backspace pairing window. */
  now?: () => number;
}

export type TerminalInputFocusRequest = "focus" | "refocus" | "none";

export interface TerminalInputHandle {
  focus: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

interface TerminalInputProps {
  isKeyboardVisible: boolean;
  onFocus?: () => void;
  onInput?: (data: string) => void;
  onTerminalKey?: (event: NativeTerminalKeyEvent) => void;
  style?: StyleProp<TextStyle>;
}

// Scripts produced by CJK IMEs when they commit or update a candidate. The
// native input does not expose marked-text ranges, so the committed script is
// the only reliable distinction between composition and ordinary autocorrect.
const CJK_COMPOSITION_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

// Only ASCII travels the keypress path. An IME script reports the jamo it is
// composing, which the text-change diff below immediately contradicts, so
// forwarding both would put two conflicting characters on the wire.
function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key <= "~";
}

function getCommonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/**
 * What the terminal receives for an edit that is not a plain append.
 *
 * CJK IMEs rewrite their composing suffix in place. Korean updates one
 * syllable at a time (`ㅎ` -> `하` -> `한`), while Chinese and Japanese replace
 * a multi-character reading (`nihao` -> `你好`, `にほんご` -> `日本語`). None of
 * those are appends, so rub out the rewritten suffix and send the replacement.
 *
 * The inserted suffix must contain a CJK script. Ordinary autocorrect and
 * suggestion replacements stay swallowed: the hidden input can edit text the
 * terminal has already committed, and the terminal cannot take it back.
 */
function resolveCompositionEdit(previousText: string, text: string): string {
  const previousCharacters = Array.from(previousText);
  const nextCharacters = Array.from(text);
  const commonPrefixLength = getCommonPrefixLength(previousCharacters, nextCharacters);
  const removed = previousCharacters.slice(commonPrefixLength);
  const inserted = nextCharacters.slice(commonPrefixLength).join("");
  if (removed.length === 0 || inserted.length === 0) {
    return "";
  }
  if (!CJK_COMPOSITION_PATTERN.test(inserted)) {
    return "";
  }
  return `${"\x7f".repeat(removed.length)}${inserted}`;
}

function hasLineBreak(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

export function resolveTerminalInputFocusRequest(input: {
  isInputFocused: boolean;
  isKeyboardVisible: boolean;
}): TerminalInputFocusRequest {
  if (!input.isInputFocused) {
    return "focus";
  }
  return input.isKeyboardVisible ? "none" : "refocus";
}

export function createTerminalTextInputState(
  options: TerminalTextInputStateOptions = {},
): TerminalTextInputState {
  if (options.printableSource === "diff") {
    return createDiffTerminalTextInputState(options.now ?? nativeTerminalPerformanceNow);
  }
  return createKeyThenDiffTerminalTextInputState();
}

function createKeyThenDiffTerminalTextInputState(): TerminalTextInputState {
  let previousText = "";
  let submittedText: string | null = null;
  // A swallowed replacement leaves the terminal holding text the buffer no
  // longer describes. A composition rubout deletes from the terminal, so it
  // would delete whatever is actually sitting there rather than the character
  // the buffer thinks it is replacing. Stay off until the input state resets.
  let replacementDesynced = false;

  return {
    receiveKeyPress(key: string): TerminalTextInputChange {
      const terminalKey = resolveNativeTerminalKey(key);
      if (terminalKey) {
        return { data: "", key: terminalKey, shouldClear: false };
      }
      if (key === "Backspace") {
        previousText = Array.from(previousText).slice(0, -1).join("");
        if (replacementDesynced) {
          return { data: "", shouldClear: false };
        }
        return { data: "\x7f", shouldClear: false };
      }
      if (key === "Enter" || key === "Return" || key === "return") {
        submittedText = previousText;
        return { data: "\r", shouldClear: true };
      }
      if (isPrintableKey(key)) {
        previousText += key;
        return { data: key, shouldClear: false };
      }
      return { data: "", shouldClear: false };
    },
    receiveTextChange(text: string): TerminalTextInputChange {
      if (submittedText !== null) {
        const lateSubmitText = `${submittedText}\n`;
        submittedText = null;
        if (text === lateSubmitText) {
          previousText = "";
          replacementDesynced = false;
          return { data: "", shouldClear: false };
        }
      }

      if (text.length === 0) {
        previousText = "";
        return { data: "", shouldClear: false };
      }

      if (hasLineBreak(text)) {
        previousText = "";
        replacementDesynced = false;
        return { data: "", shouldClear: true };
      }

      if (!text.startsWith(previousText)) {
        let compositionEdit = "";
        if (!replacementDesynced) {
          compositionEdit = resolveCompositionEdit(previousText, text);
        }
        if (compositionEdit === "") {
          replacementDesynced = true;
        }
        previousText = text;
        return { data: compositionEdit, shouldClear: false };
      }

      const appendedText = text.slice(previousText.length);
      previousText = text;
      return {
        data: appendedText,
        shouldClear: false,
      };
    },
    noteHardwareClear(): void {},
    reset(): void {
      previousText = "";
      replacementDesynced = false;
    },
  };
}

// Both halves of a Backspace (its key and its shrinking text change) come
// from one native call or IME batch, so they land well inside this window.
const BACKSPACE_PAIR_WINDOW_MS = 100;

/**
 * What the diff policy is waiting for. Only one thing can be pending, because
 * every event settles the previous one first (`takePending`).
 *
 * - `keyAwaitingShrink`, `shrinkAwaitingKey`: a Backspace key and its text
 *   change, paired in either order within the window.
 * - `keyOnMarker`: a Backspace key on an empty field while a stuck-clear
 *   marker is set; the change that follows may be a Backspace into that line.
 * - `emptied`: a change emptied the field. A Backspace key next sends the
 *   deletion; anything else sends it first. The hardware-key hook drops it.
 * - `newlineChange`: a change already sent Enter; an Enter key next is its
 *   echo.
 * - `enterKey`: an Enter key arrived first. A newline change next sends the
 *   Enter; anything else sends it first.
 */
type PendingInput =
  | { kind: "keyAwaitingShrink" | "shrinkAwaitingKey" | "keyOnMarker"; at: number }
  | { kind: "emptied"; count: number }
  | { kind: "newlineChange" | "enterKey" };

const LINE_BREAK_AT_END = /(?:\r\n|\n|\r)$/;

function isEnterKey(key: string): boolean {
  // RN reports a commit of up to two characters as the key, so `s\n` is a
  // letter and Enter in one.
  return (
    key === "Enter" ||
    key === "Return" ||
    key === "return" ||
    (key.length <= 2 && key.endsWith("\n"))
  );
}

function createDiffTerminalTextInputState(now: () => number): TerminalTextInputState {
  let previousText = "";
  // Same meaning as in keyThenDiff, but it only gates the CJK rubout here.
  // Backspace keeps working after a swallowed replacement.
  let replacementDesynced = false;
  // The field text when a clear was requested after a line break. If the
  // next change still starts with it, the clear never landed (seen with the
  // AOSP keyboard), so diff against it instead. A single-line paste has no
  // line break, so it can never match.
  let pendingClearFrom: string | null = null;
  let pending: PendingInput | null = null;

  function isFresh(entry: PendingInput | null, kind: PendingInput["kind"]): boolean {
    return (
      entry !== null &&
      entry.kind === kind &&
      "at" in entry &&
      now() - entry.at <= BACKSPACE_PAIR_WINDOW_MS
    );
  }

  /** Clears the pending slot, returning what an unpaired lazy entry still owes the terminal. */
  function takePending(): { entry: PendingInput | null; owed: string } {
    const entry = pending;
    pending = null;
    if (entry?.kind === "emptied") return { entry, owed: "\x7f".repeat(entry.count) };
    if (entry?.kind === "enterKey") return { entry, owed: "\r" };
    return { entry, owed: "" };
  }

  function requestClear(text: string): void {
    if (hasLineBreak(text)) {
      pendingClearFrom = text;
    }
    previousText = "";
  }

  function receiveBackspaceKey(): TerminalTextInputChange {
    const entry = pending;
    pending = null;
    if (entry?.kind === "emptied") {
      return { data: "\x7f".repeat(entry.count), shouldClear: false };
    }
    const owed = entry?.kind === "enterKey" ? "\r" : "";
    // The pending slot already guarantees this key is the next event after
    // its change, so no time limit: a JS stall between them must not split them.
    if (entry?.kind === "shrinkAwaitingKey") {
      return { data: owed, shouldClear: false };
    }
    if (previousText.length > 0) {
      pending = { kind: "keyAwaitingShrink", at: now() };
      return { data: owed, shouldClear: false };
    }
    if (pendingClearFrom !== null) {
      pending = { kind: "keyOnMarker", at: now() };
    }
    return { data: `${owed}\x7f`, shouldClear: false };
  }

  // A Backspace key on an empty field, then the old line without its line
  // break: a Backspace into a line whose clear never landed. This needs the
  // key first (AOSP order); see the plan's known gap for the other.
  function isBackspaceIntoStuckLine(
    entry: PendingInput | null,
    marker: string | null,
    text: string,
  ): boolean {
    return (
      marker !== null &&
      isFresh(entry, "keyOnMarker") &&
      LINE_BREAK_AT_END.test(marker) &&
      text === marker.replace(LINE_BREAK_AT_END, "")
    );
  }

  function receiveAppend(
    text: string,
    appendedText: string,
    entry: PendingInput | null,
    owed: string,
  ): TerminalTextInputChange {
    const lineBreak = /\r\n|\n|\r/.exec(appendedText);
    if (!lineBreak) {
      previousText = text;
      return { data: `${owed}${appendedText}`, shouldClear: false };
    }
    if (lineBreak.index + lineBreak[0].length < appendedText.length) {
      // A multi-line paste is not run.
      requestClear(text);
      return { data: owed, shouldClear: true };
    }
    return sendEnterFromChange(text, entry, owed, appendedText.slice(0, lineBreak.index));
  }

  // Text then Enter. The change is the source of Enter; an Enter key that
  // came first (`enterKey`, settled into `owed`) or follows is its echo.
  function sendEnterFromChange(
    text: string,
    entry: PendingInput | null,
    owed: string,
    typed: string,
  ): TerminalTextInputChange {
    requestClear(text);
    const heldEnter = entry?.kind === "enterKey";
    if (!heldEnter) {
      pending = { kind: "newlineChange" };
    }
    return { data: `${heldEnter ? "" : owed}${typed}\r`, shouldClear: true };
  }

  function receiveShrink(
    text: string,
    entry: PendingInput | null,
    owed: string,
  ): TerminalTextInputChange {
    const removed = Array.from(previousText).length - Array.from(text).length;
    const pairedKey = isFresh(entry, "keyAwaitingShrink");
    previousText = text;
    if (text.length === 0 && !pairedKey) {
      // Either a Backspace whose key is still to come, or the hardware
      // keyboard module clearing the field. The next event decides.
      pending = { kind: "emptied", count: removed };
      return { data: owed, shouldClear: false };
    }
    if (!pairedKey) {
      pending = { kind: "shrinkAwaitingKey", at: now() };
    }
    return { data: `${owed}${"\x7f".repeat(removed)}`, shouldClear: false };
  }

  // Autocorrect, a reopened word, or a CJK rewrite. When Backspace drives it
  // (a Hangul syllable losing a jamo), pair it with the key like a shrink.
  function receiveReplacement(
    text: string,
    entry: PendingInput | null,
    owed: string,
  ): TerminalTextInputChange {
    // An autocorrect committed together with Enter: replace, then Enter.
    const line = text.replace(LINE_BREAK_AT_END, "");
    const withEnter = line !== text && !hasLineBreak(line);
    if (!withEnter && !isFresh(entry, "keyAwaitingShrink")) {
      pending = { kind: "shrinkAwaitingKey", at: now() };
    }
    let compositionEdit = "";
    if (!replacementDesynced) {
      compositionEdit = resolveCompositionEdit(previousText, withEnter ? line : text);
    }
    if (compositionEdit === "") {
      replacementDesynced = true;
    }
    previousText = text;
    if (!withEnter) {
      return { data: `${owed}${compositionEdit}`, shouldClear: false };
    }
    return sendEnterFromChange(text, entry, owed, compositionEdit);
  }

  function receiveEnterKey(): TerminalTextInputChange {
    const { entry, owed } = takePending();
    if (entry?.kind !== "newlineChange") {
      pending = { kind: "enterKey" };
    }
    return { data: owed, shouldClear: false };
  }

  return {
    receiveKeyPress(key: string): TerminalTextInputChange {
      if (key === "Backspace") {
        return receiveBackspaceKey();
      }
      if (isEnterKey(key)) {
        return receiveEnterKey();
      }
      const { owed } = takePending();
      const terminalKey = resolveNativeTerminalKey(key);
      if (terminalKey) {
        return { data: owed, key: terminalKey, shouldClear: false };
      }
      return { data: owed, shouldClear: false };
    },
    receiveTextChange(text: string): TerminalTextInputChange {
      const { entry, owed } = takePending();
      const marker = pendingClearFrom;
      pendingClearFrom = null;
      if (isBackspaceIntoStuckLine(entry, marker, text)) {
        // The shell already ran that line, so realign without typing it again.
        previousText = text;
        return { data: owed, shouldClear: false };
      }
      // A change equal to the marker is new text: a field that kept the
      // marker would not report a change at all.
      const base =
        marker !== null && text !== marker && text.startsWith(marker) ? marker : previousText;
      if (text === base) {
        previousText = text;
        return { data: owed, shouldClear: false };
      }
      if (text.startsWith(base)) {
        return receiveAppend(text, text.slice(base.length), entry, owed);
      }
      if (base === previousText && previousText.startsWith(text)) {
        return receiveShrink(text, entry, owed);
      }
      return receiveReplacement(text, entry, owed);
    },
    noteHardwareClear(): void {
      previousText = "";
      if (pending?.kind !== "enterKey") {
        pending = null;
      }
    },
    reset(): void {
      previousText = "";
      replacementDesynced = false;
      // An Enter in flight spans the clear it requested.
      if (pending?.kind !== "newlineChange" && pending?.kind !== "enterKey") {
        pending = null;
      }
    },
  };
}

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(
  function TerminalInput({ isKeyboardVisible, onFocus, onInput, onTerminalKey, style }, ref) {
    const inputRef = useRef<EditingTextInputHandle>(null);
    const isFocusedRef = useRef(false);
    const pendingFocusFrameRef = useRef<number | null>(null);
    const inputState = useMemo(
      () =>
        createTerminalTextInputState({
          printableSource: Platform.OS === "android" ? "diff" : "keyThenDiff",
        }),
      [],
    );
    const inputStyle = useMemo(() => [styles.input, style], [style]);

    const clearPendingFocus = useCallback(() => {
      if (pendingFocusFrameRef.current === null) {
        return;
      }
      cancelAnimationFrame(pendingFocusFrameRef.current);
      pendingFocusFrameRef.current = null;
    }, []);

    const resetNativeInput = useCallback(
      (reason: TerminalInputResetReason) => {
        traceTerminalReset(reason);
        inputState.reset();
        inputRef.current?.replaceText("");
      },
      [inputState],
    );

    const showNativeKeyboard = useCallback(() => {
      clearPendingFocus();
      const input = inputRef.current;
      if (!input) {
        return;
      }

      // Keep the native IME buffer aligned with the terminal. Some keyboards
      // do not emit a text change when a clipboard item replaces identical
      // stale input, so clear the buffer even when focus is already correct.
      resetNativeInput("show-keyboard");

      const focusRequest = resolveTerminalInputFocusRequest({
        isInputFocused: isFocusedRef.current || input.isFocused(),
        isKeyboardVisible,
      });
      if (focusRequest === "none") {
        return;
      }

      if (focusRequest === "focus") {
        input.focus();
        return;
      }

      input.blur();
      isFocusedRef.current = false;
      input.focus();
      pendingFocusFrameRef.current = requestAnimationFrame(() => {
        pendingFocusFrameRef.current = null;
        inputRef.current?.focus();
      });
    }, [clearPendingFocus, isKeyboardVisible, resetNativeInput]);

    const blurNativeInput = useCallback(() => {
      clearPendingFocus();
      inputRef.current?.blur();
      isFocusedRef.current = false;
      resetNativeInput("blur");
    }, [clearPendingFocus, resetNativeInput]);

    const focusNativeInput = useCallback(() => {
      showNativeKeyboard();
    }, [showNativeKeyboard]);

    useEffect(() => clearPendingFocus, [clearPendingFocus]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          focusNativeInput();
        },
        showKeyboard: () => {
          showNativeKeyboard();
        },
        blur: () => {
          blurNativeInput();
        },
      }),
      [blurNativeInput, focusNativeInput, showNativeKeyboard],
    );

    const releaseTypingScopeRef = useRef<(() => void) | null>(null);
    const releaseHardwareKeysRef = useRef<(() => void) | null>(null);
    const handleHardwareTerminalKey = useStableEvent((event: NativeTerminalKeyEvent) => {
      traceTerminalInput(
        "hwkey",
        `${event.ctrl ? "C-" : ""}${event.alt ? "A-" : ""}${event.meta ? "M-" : ""}${event.key}`,
        "",
      );
      inputState.noteHardwareClear();
      onTerminalKey?.(event);
    });
    useEffect(
      () => () => {
        releaseTypingScopeRef.current?.();
        releaseHardwareKeysRef.current?.();
      },
      [],
    );

    const handleFocus = useCallback(() => {
      isFocusedRef.current = true;
      releaseTypingScopeRef.current?.();
      releaseTypingScopeRef.current = claimNativeTypingScope("terminal");
      releaseHardwareKeysRef.current?.();
      releaseHardwareKeysRef.current = hardwareTerminalKeys.claim(handleHardwareTerminalKey);
      onFocus?.();
    }, [handleHardwareTerminalKey, onFocus]);

    const handleBlur = useCallback(() => {
      isFocusedRef.current = false;
      releaseTypingScopeRef.current?.();
      releaseTypingScopeRef.current = null;
      releaseHardwareKeysRef.current?.();
      releaseHardwareKeysRef.current = null;
      resetNativeInput("blurred");
    }, [resetNativeInput]);

    const handleChangeText = useCallback(
      (text: string) => {
        const change = inputState.receiveTextChange(text);
        traceTerminalInput("change", text, change.data);
        if (change.data.length > 0) {
          onInput?.(change.data);
        }
        if (change.shouldClear) {
          resetNativeInput("enter");
        }
      },
      [inputState, onInput, resetNativeInput],
    );

    const handleKeyPress = useCallback(
      (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const change = inputState.receiveKeyPress(event.nativeEvent.key);
        traceTerminalInput("key", event.nativeEvent.key, change.data);
        if (change.key) {
          onTerminalKey?.(createNativeTerminalKeyEvent(change.key));
        }
        if (change.data.length > 0) {
          onInput?.(change.data);
        }
        if (change.shouldClear) {
          resetNativeInput("key-enter");
        }
      },
      [inputState, onInput, onTerminalKey, resetNativeInput],
    );

    return (
      // No keyboardType prop: `ascii-capable` drops the globe key on iOS, which
      // is how you reach the Korean layout. Terminal safety comes from
      // autoCorrect/spellCheck/autoCapitalize being off, not from the layout.
      <TextInput
        ref={inputRef}
        accessibilityLabel="Terminal input"
        accessible={true}
        autoCapitalize="none"
        autoCorrect={false}
        caretHidden={true}
        contextMenuHidden={TERMINAL_INPUT_CONTEXT_MENU_HIDDEN}
        initialValue=""
        blurOnSubmit={false}
        importantForAutofill="no"
        multiline={true}
        nativeID={TERMINAL_INPUT_NATIVE_ID}
        onChangeText={handleChangeText}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyPress={handleKeyPress}
        showSoftInputOnFocus={true}
        spellCheck={false}
        style={inputStyle}
        testID="terminal-native-input"
        textContentType="none"
      />
    );
  },
);

const styles = StyleSheet.create({
  input: {
    backgroundColor: "transparent",
    color: "transparent",
    height: TERMINAL_INPUT_HITBOX_SIZE,
    left: 0,
    opacity: 0.01,
    padding: 0,
    position: "absolute",
    top: 0,
    width: TERMINAL_INPUT_HITBOX_SIZE,
  },
});
