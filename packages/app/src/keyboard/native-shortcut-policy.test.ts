import { describe, expect, it } from "vitest";
import { buildEffectiveBindings, DEFAULT_BINDINGS } from "./keyboard-shortcuts";
import {
  buildNativeShortcutPolicy,
  type NativeShortcutCombo,
  type NativeShortcutPolicy,
  type NativeTypingScope,
  parseNativeShortcutKeyEvent,
} from "./native-shortcut-policy";

function policyFor(
  input: { isMac?: boolean; typingScope?: NativeTypingScope; commandCenterOpen?: boolean } = {},
): NativeShortcutPolicy {
  return buildNativeShortcutPolicy({
    bindings: DEFAULT_BINDINGS,
    isMac: input.isMac ?? false,
    commandCenterOpen: input.commandCenterOpen ?? false,
    typingScope: input.typingScope ?? "editable",
  });
}

function find(
  combos: NativeShortcutCombo[],
  spec: Partial<Pick<NativeShortcutCombo, "code" | "ctrl" | "meta" | "alt" | "shift">>,
): NativeShortcutCombo | undefined {
  const wanted = { ctrl: false, meta: false, alt: false, shift: false, ...spec };
  return combos.find(
    (combo) =>
      combo.code === wanted.code &&
      combo.ctrl === wanted.ctrl &&
      combo.meta === wanted.meta &&
      combo.alt === wanted.alt &&
      combo.shift === wanted.shift,
  );
}

describe("buildNativeShortcutPolicy", () => {
  it("puts a binding web fires inside a text field in `always`", () => {
    const android = policyFor();
    expect(find(android.always, { code: "KeyK", ctrl: true })).toMatchObject({
      key: "k",
      consume: true,
    });
    expect(find(android.whenNotTyping, { code: "KeyK", ctrl: true })).toBeUndefined();

    const ios = policyFor({ isMac: true });
    expect(find(ios.always, { code: "KeyK", meta: true })).toMatchObject({ consume: true });
    expect(find(ios.always, { code: "KeyK", ctrl: true })).toBeUndefined();
  });

  it("keeps editable-guarded and focus-scoped bindings out of `always`", () => {
    const ios = policyFor({ isMac: true });
    // Cmd+Shift+Arrow keeps selecting text in a field (`editable: false`).
    expect(find(ios.always, { code: "ArrowLeft", meta: true, shift: true })).toBeUndefined();
    expect(find(ios.whenNotTyping, { code: "ArrowLeft", meta: true, shift: true })).toBeDefined();
    // Space toggles voice mute only outside text fields (`focusScope: "other"`).
    expect(find(ios.always, { code: "Space" })).toBeUndefined();
    expect(find(ios.whenNotTyping, { code: "Space" })).toMatchObject({ consume: true });
  });

  it("reports bare keys while typing without swallowing them", () => {
    expect(find(policyFor().always, { code: "Enter" })).toMatchObject({ consume: false });
    // Web never blocks Escape (`preventDefault: false`), typing or not.
    expect(find(policyFor().whenNotTyping, { code: "Escape" })).toMatchObject({ consume: false });
  });

  it("follows the focused input's scope", () => {
    const composer = policyFor({ typingScope: "message-input" });
    expect(find(composer.always, { code: "Tab", shift: true })).toBeDefined();
    expect(find(composer.always, { code: "KeyD", ctrl: true })).toBeDefined();

    const terminal = policyFor({ typingScope: "terminal" });
    expect(find(terminal.always, { code: "Tab", shift: true })).toBeUndefined();
    // Ctrl+D is `terminal: false`: the terminal keeps it while focused.
    expect(find(terminal.always, { code: "KeyD", ctrl: true })).toBeUndefined();
    expect(find(terminal.whenNotTyping, { code: "KeyD", ctrl: true })).toBeDefined();
  });

  it("publishes only the next step of a chord in progress", () => {
    const bindings = buildEffectiveBindings({ "command-center-toggle-ctrl-k-non-mac": "Ctrl+J G" });
    const index = bindings.findIndex(
      (binding) => binding.id === "command-center-toggle-ctrl-k-non-mac",
    );
    const policy = buildNativeShortcutPolicy({
      bindings,
      chordState: { candidateIndices: [index], step: 1, timeoutId: null },
      isMac: false,
      commandCenterOpen: false,
      typingScope: "editable",
    });
    expect(policy).toEqual({
      always: [
        {
          code: "KeyG",
          key: "g",
          alt: false,
          ctrl: false,
          meta: false,
          shift: false,
          consume: false,
        },
      ],
      whenNotTyping: [],
    });
  });
});

describe("parseNativeShortcutKeyEvent", () => {
  it("accepts the native payload and rejects malformed ones", () => {
    const payload = {
      key: "k",
      code: "KeyK",
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      typing: true,
    };
    expect(parseNativeShortcutKeyEvent(payload)).toEqual({
      event: {
        key: "k",
        code: "KeyK",
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      },
      typing: true,
    });
    expect(parseNativeShortcutKeyEvent({ ...payload, code: "" })).toBeNull();
    expect(parseNativeShortcutKeyEvent({ ...payload, typing: undefined })).toBeNull();
    expect(parseNativeShortcutKeyEvent(null)).toBeNull();
  });
});
