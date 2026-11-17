import { describe, expect, it } from "vitest";
import { formatShortcut } from "@/utils/format-shortcut";
import {
  normalizeShortcutCapture,
  comboStringToShortcutKeys,
  keyComboToString,
  keyboardEventToComboString,
  parseShortcutString,
  SHORTCUT_KEY_NAMES,
} from "./shortcut-string";

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("keyboardEventToComboString", () => {
  it("captures the Dvorak character rather than its QWERTY position", () => {
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "b", code: "KeyN", metaKey: true })),
    ).toBe("Cmd+B");
  });

  it("captures shifted Dvorak letters and punctuation at other physical positions", () => {
    expect(
      keyboardEventToComboString(
        keyboardEvent({ key: "T", code: "KeyK", metaKey: true, shiftKey: true }),
      ),
    ).toBe("Shift+Cmd+T");
    expect(
      keyboardEventToComboString(keyboardEvent({ key: ";", code: "KeyZ", ctrlKey: true })),
    ).toBe("Ctrl+;");
    expect(
      keyboardEventToComboString(
        keyboardEvent({ key: "?", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("Ctrl+Shift+/");
  });

  it("keeps named keys and rewritten Option characters capturable", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "ArrowLeft", code: "ArrowLeft" }))).toBe(
      "ArrowLeft",
    );
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "†", code: "KeyT", altKey: true })),
    ).toBe("Alt+T");
  });

  it("does not record a named key that dispatch does not support", () => {
    expect(
      keyboardEventToComboString(
        keyboardEvent({ key: "Enter", code: "NumpadEnter", ctrlKey: true }),
      ),
    ).toBeNull();
  });

  it("captures the minus key (regression: previously returned null)", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "-", code: "Minus" }))).toBe("-");
  });

  it("captures minus with modifiers", () => {
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "-", code: "Minus", metaKey: true })),
    ).toBe("Cmd+-");
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "_", code: "Minus", shiftKey: true })),
    ).toBe("Shift+-");
  });

  it("captures equal, semicolon, and quote", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "=", code: "Equal" }))).toBe("=");
    expect(keyboardEventToComboString(keyboardEvent({ key: ";", code: "Semicolon" }))).toBe(";");
    expect(keyboardEventToComboString(keyboardEvent({ key: "'", code: "Quote" }))).toBe("'");
  });

  it("still returns null for modifier-only presses", () => {
    expect(keyboardEventToComboString(keyboardEvent({ code: "ShiftLeft" }))).toBeNull();
  });
});

describe("parseShortcutString round-trips punctuation keys", () => {
  const cases: ReadonlyArray<[string, string, string, string]> = [
    ["-", "Minus", "-", "_"],
    ["=", "Equal", "=", "+"],
    [";", "Semicolon", ";", ":"],
    ["'", "Quote", "'", '"'],
  ];

  for (const [humanKey, code, key, shiftedKey] of cases) {
    it(`round-trips ${humanKey}`, () => {
      const combo = parseShortcutString(humanKey);
      expect(combo.code).toBe(code);
      expect(combo.key).toBe(key);
      expect(combo.shiftedKey).toBe(shiftedKey);
      expect(keyComboToString(combo)).toBe(humanKey);
    });
  }

  it("round-trips a modifier combo with minus", () => {
    const combo = parseShortcutString("Cmd+-");
    expect(combo.meta).toBe(true);
    expect(combo.code).toBe("Minus");
    expect(keyComboToString(combo)).toBe("Cmd+-");
  });
});

describe("comboStringToShortcutKeys", () => {
  it("maps every modifier spelling onto its display token", () => {
    expect(comboStringToShortcutKeys("Cmd+Ctrl+Alt+Shift+K")).toEqual([
      "mod",
      "ctrl",
      "alt",
      "shift",
      "K",
    ]);
    // `parseShortcutString` accepts `Mod` as well, so the display path has to.
    expect(comboStringToShortcutKeys("Mod+K")).toEqual(["mod", "K"]);
  });

  it("hands named keys to the display table under the names it uses", () => {
    expect(comboStringToShortcutKeys("Cmd+Shift+ArrowLeft")).toEqual(["mod", "shift", "Left"]);
    expect(formatShortcut(comboStringToShortcutKeys("Cmd+Shift+ArrowLeft"), "mac")).toBe("⇧⌘←");
    expect(formatShortcut(comboStringToShortcutKeys("Escape"), "mac")).toBe("Esc");
    expect(formatShortcut(comboStringToShortcutKeys("Backspace"), "mac")).toBe("⌫");
  });

  // The whole class, not just the arrows: uppercasing key names used to push
  // every multi-character name past `KEY_DISPLAY`, so an override on one of them
  // rendered as a shouty raw code — `ARROWLEFT`, `ESCAPE`, `PAGEDOWN`.
  it("never emits a shouty raw code for any key the capture path can produce", () => {
    for (const name of SHORTCUT_KEY_NAMES) {
      // `F1` and the digits are already all-caps, so only names that contain a
      // lowercase letter can exhibit the bug.
      if (name === name.toUpperCase()) continue;
      const [key] = comboStringToShortcutKeys(name);
      const rendered = formatShortcut([key], "non-mac");
      expect(rendered, `${name} renders as ${rendered}`).not.toBe(name.toUpperCase());
    }
  });
});

describe("shortcut capture ownership", () => {
  const key = (code: string, extra: Partial<KeyboardEvent> = {}) =>
    keyboardEvent({ code, key: code, ...extra });
  it("reserves navigation while Ctrl and Cmd combinations remain capturable", () => {
    for (const code of [
      "Backspace",
      "Escape",
      "Tab",
      "Enter",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
    ]) {
      for (const extra of [{ ctrlKey: true }, { metaKey: true }]) {
        expect(normalizeShortcutCapture(key(code, extra), true)).toEqual({
          kind: "combo",
          value: `${extra.ctrlKey ? "Ctrl" : "Cmd"}+${code}`,
        });
      }
    }
    for (const code of ["Tab", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      for (const extra of [{}, { shiftKey: true }, { altKey: true }])
        expect(normalizeShortcutCapture(key(code, extra), false)).toEqual({ kind: "pass" });
    }
  });
  it("edits capture only outside focused text", () => {
    expect(normalizeShortcutCapture(key("Backspace"), false)).toEqual({ kind: "remove" });
    expect(normalizeShortcutCapture(key("Escape"), false)).toEqual({ kind: "cancel" });
    for (const code of ["Backspace", "Escape", "KeyA", "Space", "Delete"])
      expect(normalizeShortcutCapture(key(code), true)).toEqual({ kind: "pass" });
    expect(normalizeShortcutCapture(key("Backspace", { altKey: true }), false)).toEqual({
      kind: "pass",
    });
  });
  it("previews modifiers and records logical punctuation without duplicate repeat steps", () => {
    expect(
      normalizeShortcutCapture(key("ControlLeft", { key: "Control", ctrlKey: true }), false),
    ).toEqual({ kind: "modifiers", value: "Ctrl" });
    expect(normalizeShortcutCapture(key("KeyN", { key: "b", ctrlKey: true }), true)).toEqual({
      kind: "combo",
      value: "Ctrl+B",
    });
    expect(normalizeShortcutCapture(key("Minus", { key: "_", shiftKey: true }), false)).toEqual({
      kind: "combo",
      value: "Shift+-",
    });
    expect(
      normalizeShortcutCapture(key("KeyJ", { key: "j", ctrlKey: true, repeat: true }), true),
    ).toEqual({ kind: "ignore" });
    expect(normalizeShortcutCapture(key("Backspace", { repeat: true }), false)).toEqual({
      kind: "ignore",
    });
    expect(normalizeShortcutCapture(key("Tab", { repeat: true }), false)).toEqual({ kind: "pass" });
  });
  it("leaves composition, dead and unsupported keys with the input", () => {
    for (const extra of [{ isComposing: true }, { key: "Dead" }, { key: "Process" }])
      expect(normalizeShortcutCapture(key("KeyA", extra), false)).toEqual({ kind: "pass" });
    expect(normalizeShortcutCapture(key("Unmapped", { key: "Unidentified" }), false)).toEqual({
      kind: "pass",
    });
  });
});
