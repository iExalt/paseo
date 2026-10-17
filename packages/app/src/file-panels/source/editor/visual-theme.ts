import type { HighlightStyle } from "@getpaseo/highlight";

/** The app theme as the file editor and source view draw it, on every platform. */
export interface EditorVisualTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
}
