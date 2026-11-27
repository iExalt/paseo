import { describe, expect, it } from "vitest";
import { isSettingsSectionAvailable } from "./section-availability";

const desktop = {
  isDesktopApp: true,
  isWeb: true,
  keyboardShortcutsAvailable: true,
  browserNotificationsAvailable: true,
};
const browser = {
  isDesktopApp: false,
  isWeb: true,
  keyboardShortcutsAvailable: true,
  browserNotificationsAvailable: true,
};
const native = {
  isDesktopApp: false,
  isWeb: false,
  keyboardShortcutsAvailable: false,
  browserNotificationsAvailable: false,
};
const nativeWithKeyboard = { ...native, keyboardShortcutsAvailable: true };

describe("isSettingsSectionAvailable", () => {
  it("hides notifications in a browser without the Notification API", () => {
    expect(
      isSettingsSectionAvailable("notifications", {
        ...browser,
        browserNotificationsAvailable: false,
      }),
    ).toBe(false);
  });

  it("shows each gate only where it applies", () => {
    expect(
      (["notifications", "shortcuts", "general"] as const).map((section) => [
        isSettingsSectionAvailable(section, desktop),
        isSettingsSectionAvailable(section, browser),
        isSettingsSectionAvailable(section, native),
        isSettingsSectionAvailable(section, nativeWithKeyboard),
      ]),
    ).toEqual([
      [true, true, true, true],
      [true, false, false, true],
      [true, true, true, true],
    ]);
  });
});
