import { describe, expect, it } from "vitest";
import { isSettingsSectionAvailable } from "./section-availability";

const desktop = { isDesktopApp: true, isWeb: true, keyboardShortcutsAvailable: true };
const browser = { isDesktopApp: false, isWeb: true, keyboardShortcutsAvailable: true };
const native = { isDesktopApp: false, isWeb: false, keyboardShortcutsAvailable: false };
const nativeWithKeyboard = { ...native, keyboardShortcutsAvailable: true };

describe("isSettingsSectionAvailable", () => {
  it("shows each gate only where it applies", () => {
    expect(
      (["integrations", "notifications", "shortcuts", "general"] as const).map((section) => [
        isSettingsSectionAvailable(section, desktop),
        isSettingsSectionAvailable(section, browser),
        isSettingsSectionAvailable(section, native),
        isSettingsSectionAvailable(section, nativeWithKeyboard),
      ]),
    ).toEqual([
      [true, false, false, false],
      [true, false, true, true],
      [true, false, false, true],
      [true, true, true, true],
    ]);
  });
});
