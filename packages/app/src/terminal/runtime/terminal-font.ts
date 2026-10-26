const DEFAULT_TERMINAL_FONT_SIZE = 13;

// Bundled with the app (assets/fonts/meslolgs-nf), so prompt and TUI icons render
// without a locally installed Nerd Font.
export const TERMINAL_NERD_FONT_FAMILY = "MesloLGS NF";

export const DEFAULT_TERMINAL_FONT_FAMILY = [
  `'${TERMINAL_NERD_FONT_FAMILY}'`,
  // Locally installed developer fonts, if the bundled font is unavailable.
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "JetBrainsMono NF",
  "MesloLGM Nerd Font",
  "MesloLGM NF",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  // PUA-only fallback (many Nerd glyphs live here on some systems).
  "Symbols Nerd Font",
  // System fallbacks.
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "'Liberation Mono'",
  "monospace",
].join(", ");

export function stripFontFamilyQuotes(family: string): string {
  const trimmed = family.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function splitFontFamilyStack(fontFamily: string): string[] {
  return fontFamily
    .split(",")
    .map(stripFontFamilyQuotes)
    .filter((family) => family.length > 0);
}

export function namesTerminalNerdFont(fontFamily: string): boolean {
  const nerdFont = TERMINAL_NERD_FONT_FAMILY.toLowerCase();
  return splitFontFamilyStack(fontFamily).some((family) => family.toLowerCase() === nerdFont);
}

function quoteFontFamily(family: string): string {
  return /\s/.test(family) ? `'${family}'` : family;
}

// A user font keeps drawing text; browsers fall back per glyph, so the bundled
// font only fills in the icons the user font lacks. Rebuilding the stack drops
// empty entries, which would make the whole font list invalid.
export function resolveTerminalFontFamily(fontFamily: string | undefined): string {
  const families = splitFontFamilyStack(fontFamily ?? "");
  if (families.length === 0) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  const stack = families.map(quoteFontFamily).join(", ");
  return namesTerminalNerdFont(stack) ? stack : `${stack}, '${TERMINAL_NERD_FONT_FAMILY}'`;
}

export function resolveTerminalFontSize(fontSize: number | undefined): number {
  return typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
    ? fontSize
    : DEFAULT_TERMINAL_FONT_SIZE;
}
