import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return platform.OS;
    },
    select: (options: Record<string, string>) => options[platform.OS] ?? options.default,
  },
}));

async function loadResolver(os: string) {
  platform.OS = os;
  vi.resetModules();
  const { resolveNativeTerminalFontFamily } = await import("./font.native");
  return resolveNativeTerminalFontFamily;
}

describe("resolveNativeTerminalFontFamily", () => {
  beforeEach(() => {
    platform.OS = "android";
  });

  // Until the font is embedded in the native app, naming it must not reach Text,
  // or Android would draw the terminal in its proportional default font.
  it("skips the bundled Nerd Font on Android", async () => {
    const resolve = await loadResolver("android");
    expect(resolve(undefined)).toBe("monospace");
    expect(resolve("Foo, MesloLGS NF")).toBe("monospace");
  });

  it("skips the bundled Nerd Font on iOS", async () => {
    const resolve = await loadResolver("ios");
    expect(resolve(undefined)).toBe("Menlo");
    expect(resolve("Foo, 'MesloLGS NF'")).toBe("Menlo");
  });
});
