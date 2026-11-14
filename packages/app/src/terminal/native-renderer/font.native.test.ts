import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return platform.OS;
    },
  },
}));

import { resolveNativeTerminalFontFamily } from "./font.native";

describe("resolveNativeTerminalFontFamily", () => {
  it("draws Android terminals with the bundled Nerd Font", () => {
    platform.OS = "android";
    expect(resolveNativeTerminalFontFamily(undefined)).toBe("MesloLGS Nerd Font");
    // Android has no named monospace family, and a generic one loses the icons.
    expect(resolveNativeTerminalFontFamily("Foo, monospace")).toBe("MesloLGS Nerd Font");
    expect(resolveNativeTerminalFontFamily("sans-serif-monospace")).toBe("MesloLGS Nerd Font");
  });

  it("keeps a named iOS system font the user chose", () => {
    platform.OS = "ios";
    expect(resolveNativeTerminalFontFamily(undefined)).toBe("MesloLGS Nerd Font");
    expect(resolveNativeTerminalFontFamily("'Courier New', monospace")).toBe("Courier New");
    expect(resolveNativeTerminalFontFamily("Foo, menlo")).toBe("menlo");
  });

  it("uses the bundled font for iOS generics and aliases", () => {
    platform.OS = "ios";
    expect(resolveNativeTerminalFontFamily("ui-monospace")).toBe("MesloLGS Nerd Font");
    expect(resolveNativeTerminalFontFamily("SF Mono, Menlo")).toBe("Menlo");
    expect(resolveNativeTerminalFontFamily("SF Mono")).toBe("MesloLGS Nerd Font");
    expect(resolveNativeTerminalFontFamily("'MesloLGS Nerd Font', Menlo")).toBe(
      "MesloLGS Nerd Font",
    );
  });
});
