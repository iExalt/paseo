import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_INPUT_MODE_STATE } from "@getpaseo/protocol/terminal-input-mode";
import { encodeTerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import { DEFAULT_BINDINGS } from "@/keyboard/keyboard-shortcuts";
import { buildNativeShortcutPolicy } from "@/keyboard/native-shortcut-policy";
import { createTerminalKeyInput } from "@/terminal/runtime/terminal-key-dispatch";
import { createHardwareTerminalKeyRouter } from "./hardware-terminal-keys";
import { parseNativeTerminalKeyEvent, type NativeTerminalKeyEvent } from "./terminal-key-events";

/** A key as PaseoHardwareKeyboardModule.kt reports it in `onTerminalKey`. */
function nativeKey(
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
) {
  return {
    key,
    code: "",
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    metaKey: modifiers.meta ?? false,
    repeat: false,
  };
}

function bytesFor(payload: unknown, applicationCursorKeys = false): string | null {
  const event = parseNativeTerminalKeyEvent(payload);
  if (!event) return null;
  const keyInput = createTerminalKeyInput({
    key: event.key,
    modifiers: { ctrl: event.ctrl, shift: event.shift, alt: event.alt },
    meta: event.meta,
  });
  return encodeTerminalKeyInput(keyInput, {
    inputMode: { ...DEFAULT_TERMINAL_INPUT_MODE_STATE, applicationCursorKeys },
  });
}

describe("hardware terminal keys", () => {
  it("reach the terminal as the bytes a terminal keyboard sends", () => {
    const cases: [ReturnType<typeof nativeKey>, string][] = [
      [nativeKey("Enter"), "\r"],
      [nativeKey("Backspace"), "\x7f"],
      [nativeKey("Tab"), "\t"],
      [nativeKey("Tab", { shift: true }), "\x1b[Z"],
      [nativeKey("Escape"), "\x1b"],
      [nativeKey("ArrowUp"), "\x1b[A"],
      [nativeKey("ArrowLeft", { ctrl: true }), "\x1b[1;5D"],
      [nativeKey("Delete"), "\x1b[3~"],
      [nativeKey("c", { ctrl: true }), "\x03"],
      [nativeKey("d", { ctrl: true }), "\x04"],
      [nativeKey("u", { ctrl: true }), "\x15"],
      [nativeKey("L", { ctrl: true, shift: true }), "\x0c"],
      [nativeKey("[", { ctrl: true }), "\x1b"],
      [nativeKey(" ", { ctrl: true }), "\x00"],
      [nativeKey("b", { alt: true }), "\x1bb"],
    ];
    for (const [payload, bytes] of cases) {
      expect({ payload, bytes: bytesFor(payload) }).toEqual({ payload, bytes });
    }
    expect(bytesFor(nativeKey("ArrowUp"), true)).toBe("\x1bOA");
  });

  it("drops keys the terminal cannot encode and malformed payloads", () => {
    expect(parseNativeTerminalKeyEvent(nativeKey("Unidentified", { ctrl: true }))).toBeNull();
    expect(parseNativeTerminalKeyEvent({ key: "Enter" })).toBeNull();
    expect(parseNativeTerminalKeyEvent(null)).toBeNull();
  });

  it("go only to the terminal input that most recently took focus", () => {
    let emit: (payload: unknown) => void = () => {};
    let subscriptions = 0;
    const router = createHardwareTerminalKeyRouter({
      addListener: (handler) => {
        subscriptions += 1;
        emit = handler;
        return { remove: () => (subscriptions -= 1) };
      },
    });
    const first: NativeTerminalKeyEvent[] = [];
    const second: NativeTerminalKeyEvent[] = [];

    const releaseFirst = router.claim((event) => first.push(event));
    emit(nativeKey("d", { ctrl: true }));
    const releaseSecond = router.claim((event) => second.push(event));
    releaseFirst();
    emit(nativeKey("Enter"));
    releaseSecond();
    emit(nativeKey("Escape"));

    expect(first).toEqual([{ key: "d", ctrl: true, shift: false, alt: false, meta: false }]);
    expect(second).toEqual([{ key: "Enter", ctrl: false, shift: false, alt: false, meta: false }]);
    expect(subscriptions).toBe(0);
  });

  // Native checks the shortcut policy before terminal capture. Web's rule
  // (`terminal: false` bindings do not fire in the terminal) must leave these
  // keys to the shell.
  it("are not taken by app shortcuts while the terminal has focus", () => {
    const policy = buildNativeShortcutPolicy({
      bindings: DEFAULT_BINDINGS,
      isMac: false,
      commandCenterOpen: false,
      typingScope: "terminal",
    });
    const terminalKeys = new Set([
      "KeyC+ctrl",
      "KeyD+ctrl",
      "KeyU+ctrl",
      "KeyL+ctrl",
      "Enter",
      "Backspace",
      "Tab",
      "Escape",
    ]);
    const taken = policy.always.filter((combo) => {
      if (combo.alt || combo.meta || combo.shift) return false;
      return terminalKeys.has(combo.ctrl ? `${combo.code}+ctrl` : combo.code);
    });
    expect(taken).toEqual([]);
  });
});
