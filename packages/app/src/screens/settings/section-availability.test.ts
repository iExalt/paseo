import { describe, expect, it } from "vitest";
import { isSettingsSectionAvailable } from "./section-availability";

const desktop = { isDesktopApp: true, isWeb: true };
const browser = { isDesktopApp: false, isWeb: true };
const native = { isDesktopApp: false, isWeb: false };

describe("isSettingsSectionAvailable", () => {
  it("shows each gate only where it applies", () => {
    expect(
      (["integrations", "editor", "notifications", "general"] as const).map((section) => [
        isSettingsSectionAvailable(section, desktop),
        isSettingsSectionAvailable(section, browser),
        isSettingsSectionAvailable(section, native),
      ]),
    ).toEqual([
      [true, false, false],
      [true, true, false],
      [true, false, true],
      [true, true, true],
    ]);
  });
});
