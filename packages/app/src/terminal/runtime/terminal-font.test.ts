import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  splitFontFamilyStack,
} from "./terminal-font";
import { withoutBundledTerminalFont } from "./terminal-bundled-font";

describe("resolveTerminalFontFamily", () => {
  it("leads the default stack with the bundled Nerd Font", () => {
    expect(resolveTerminalFontFamily(undefined)).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily("   ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(splitFontFamilyStack(DEFAULT_TERMINAL_FONT_FAMILY)[0]).toBe("MesloLGS Nerd Font");
  });

  it("keeps a user font first and appends the bundled font for icons", () => {
    expect(resolveTerminalFontFamily("  Fira Code, monospace ")).toBe(
      "'Fira Code', monospace, 'MesloLGS Nerd Font'",
    );
  });

  it("does not repeat the bundled font when the user stack already names it", () => {
    expect(resolveTerminalFontFamily("Foo, mesLOlgs nerd FONT")).toBe("Foo, 'mesLOlgs nerd FONT'");
    expect(resolveTerminalFontFamily('"MesloLGS Nerd Font", monospace')).toBe(
      "'MesloLGS Nerd Font', monospace",
    );
  });

  it("drops empty entries that would invalidate the font list", () => {
    expect(resolveTerminalFontFamily("Foo,, Bar,")).toBe("Foo, Bar, 'MesloLGS Nerd Font'");
  });

  it("still appends the bundled font after a differently named Meslo", () => {
    expect(resolveTerminalFontFamily("MesloLGM NF")).toBe("'MesloLGM NF', 'MesloLGS Nerd Font'");
  });
});

describe("withoutBundledTerminalFont", () => {
  it("drops the bundled font from a stack, whatever its quoting", () => {
    expect(withoutBundledTerminalFont(DEFAULT_TERMINAL_FONT_FAMILY)).not.toMatch(
      /MesloLGS Nerd Font/,
    );
    expect(withoutBundledTerminalFont('Menlo, "mesloLGS nerd font"')).toBe("Menlo");
    expect(withoutBundledTerminalFont("'MesloLGS Nerd Font'")).toBe("monospace");
    expect(withoutBundledTerminalFont("'MesloLGM NF', 'MesloLGS Nerd Font'")).toBe("'MesloLGM NF'");
  });
});
