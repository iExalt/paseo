import { describe, expect, it } from "vitest";
import { keyboardShortcutsAvailable } from "./availability";

describe("keyboardShortcutsAvailable", () => {
  it("needs a wide layout, and a hardware keyboard on native", () => {
    const cases = [
      { isNative: false, isCompact: false, hasHardwareKeyboard: false, expected: true },
      { isNative: false, isCompact: true, hasHardwareKeyboard: false, expected: false },
      { isNative: true, isCompact: false, hasHardwareKeyboard: true, expected: true },
      { isNative: true, isCompact: false, hasHardwareKeyboard: false, expected: false },
      { isNative: true, isCompact: true, hasHardwareKeyboard: true, expected: false },
    ];
    for (const { expected, ...environment } of cases) {
      expect(keyboardShortcutsAvailable(environment), JSON.stringify(environment)).toBe(expected);
    }
  });
});
