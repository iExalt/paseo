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
    expect(splitFontFamilyStack(DEFAULT_TERMINAL_FONT_FAMILY)[0]).toBe("MesloLGS NF");
  });

  it("keeps a user font first and appends the bundled font for icons", () => {
    expect(resolveTerminalFontFamily("  Fira Code, monospace ")).toBe(
      "'Fira Code', monospace, 'MesloLGS NF'",
    );
  });

  it("does not repeat the bundled font when the user stack already names it", () => {
    expect(resolveTerminalFontFamily("Foo, mesLOlgs nf")).toBe("Foo, 'mesLOlgs nf'");
    expect(resolveTerminalFontFamily('"MesloLGS NF", monospace')).toBe("'MesloLGS NF', monospace");
  });

  it("drops empty entries that would invalidate the font list", () => {
    expect(resolveTerminalFontFamily("Foo,, Bar,")).toBe("Foo, Bar, 'MesloLGS NF'");
  });

  it("still appends the bundled font after a differently named Meslo", () => {
    expect(resolveTerminalFontFamily("MesloLGM NF")).toBe("'MesloLGM NF', 'MesloLGS NF'");
  });
});

describe("withoutBundledTerminalFont", () => {
  it("drops the bundled font from a stack, whatever its quoting", () => {
    expect(withoutBundledTerminalFont(DEFAULT_TERMINAL_FONT_FAMILY)).not.toMatch(/MesloLGS NF/);
    expect(withoutBundledTerminalFont('Menlo, "mesloLGS NF"')).toBe("Menlo");
    expect(withoutBundledTerminalFont("'MesloLGS NF'")).toBe("monospace");
    expect(withoutBundledTerminalFont("'MesloLGM NF', 'MesloLGS NF'")).toBe("'MesloLGM NF'");
  });
});
