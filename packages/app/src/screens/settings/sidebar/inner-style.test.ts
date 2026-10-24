import { describe, expect, it } from "vitest";
import { getSettingsSidebarInnerStyle } from "./inner-style";

const insets = { top: 24, bottom: 112 };

describe("getSettingsSidebarInnerStyle", () => {
  it("clears top and bottom system insets on the desktop split sidebar", () => {
    expect(getSettingsSidebarInnerStyle(true, insets)).toEqual([
      { flex: 1 },
      { paddingTop: 24, paddingBottom: 112 },
    ]);
  });

  it("adds no padding on the compact layout, which its parent already pads", () => {
    expect(getSettingsSidebarInnerStyle(false, insets)).toEqual([{ flex: 1 }, null]);
  });
});
