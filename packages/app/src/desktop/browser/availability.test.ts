import { describe, expect, it } from "vitest";
import { resolveBrowserTabsAvailable } from "./availability";

describe("resolveBrowserTabsAvailable", () => {
  it("offers browser tabs in Electron and native apps but not in a plain browser", () => {
    expect(resolveBrowserTabsAvailable({ isElectron: true, isNative: false })).toBe(true);
    expect(resolveBrowserTabsAvailable({ isElectron: false, isNative: true })).toBe(true);
    expect(resolveBrowserTabsAvailable({ isElectron: false, isNative: false })).toBe(false);
  });
});
