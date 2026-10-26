import { Platform } from "react-native";
import {
  resolveTerminalFontFamily,
  splitFontFamilyStack,
  TERMINAL_NERD_FONT_FAMILY,
} from "../runtime/terminal-font";

// Families a user can name that are always installed. Generic names and aliases
// are left out: they stand in for "some monospace font", and the bundled font
// serves that better because it also carries the prompt and TUI icons.
const IOS_NAMED_MONO_FAMILIES: ReadonlySet<string> = new Set(["courier", "courier new", "menlo"]);

// Embedded by the expo-font plugin in app.config.js under this family name.
const BUNDLED_FAMILY = TERMINAL_NERD_FONT_FAMILY.toLowerCase();

// Native text can't fall back per glyph to a bundled font, so one family draws
// everything: a named system font the user chose, otherwise the bundled one.
export function resolveNativeTerminalFontFamily(fontFamily: string | undefined): string {
  const families = splitFontFamilyStack(resolveTerminalFontFamily(fontFamily));
  const named = families.find((family) => {
    const normalized = family.toLowerCase();
    return (
      normalized === BUNDLED_FAMILY ||
      (Platform.OS === "ios" && IOS_NAMED_MONO_FAMILIES.has(normalized))
    );
  });
  return named && named.toLowerCase() !== BUNDLED_FAMILY ? named : TERMINAL_NERD_FONT_FAMILY;
}
