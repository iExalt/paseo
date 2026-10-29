import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TERMINAL_NERD_FONT_FAMILY } from "./terminal-font";

// Native apps embed these TTFs, and the web woff2 copies are converted from them.
const FONT_FILES = ["meslolgs_nf_regular.ttf", "meslolgs_nf_bold.ttf"];

function readFont(file: string): DataView {
  const bytes = readFileSync(new URL(`../../../assets/fonts/meslolgs-nf/${file}`, import.meta.url));
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tableOffset(font: DataView, tag: string): number {
  const numTables = font.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const recordTag = String.fromCharCode(...[0, 1, 2, 3].map((j) => font.getUint8(record + j)));
    if (recordTag === tag) {
      return font.getUint32(record + 8);
    }
  }
  throw new Error(`no ${tag} table`);
}

// Windows-platform family name (name ID 1), which iOS registers the font under.
function familyName(font: DataView): string {
  const table = tableOffset(font, "name");
  const count = font.getUint16(table + 2);
  const strings = table + font.getUint16(table + 4);
  for (let i = 0; i < count; i++) {
    const record = table + 6 + i * 12;
    if (font.getUint16(record) === 3 && font.getUint16(record + 6) === 1) {
      const length = font.getUint16(record + 8);
      const start = strings + font.getUint16(record + 10);
      const units = Array.from({ length: length / 2 }, (_, j) => font.getUint16(start + j * 2));
      return String.fromCharCode(...units);
    }
  }
  throw new Error("no family name");
}

// Code points in the format 12 (full Unicode) cmap subtable.
function hasGlyphs(font: DataView, codePoints: number[]): boolean[] {
  const cmap = tableOffset(font, "cmap");
  for (let i = 0; i < font.getUint16(cmap + 2); i++) {
    const subtable = cmap + font.getUint32(cmap + 4 + i * 8 + 4);
    if (font.getUint16(subtable) !== 12) {
      continue;
    }
    const groups = font.getUint32(subtable + 12);
    return codePoints.map((codePoint) => {
      for (let g = 0; g < groups; g++) {
        const group = subtable + 16 + g * 12;
        if (codePoint >= font.getUint32(group) && codePoint <= font.getUint32(group + 4)) {
          return true;
        }
      }
      return false;
    });
  }
  throw new Error("no format 12 cmap");
}

describe.each(FONT_FILES)("bundled terminal font %s", (file) => {
  const font = readFont(file);

  it("is registered under the family the terminal asks for", () => {
    expect(familyName(font)).toBe(TERMINAL_NERD_FONT_FAMILY);
  });

  it("carries icons added after Nerd Fonts 2.3.3", () => {
    // nf-md, then Starship's container (Octicons), sudo (Font Awesome 6),
    // Typst (logos) and V (Seti-UI) symbols, and braille for TUI spinners.
    const codePoints = [0xf0001, 0xf4b7, 0xef01, 0xf37f, 0xe6ac, 0x2800];
    expect(hasGlyphs(font, codePoints)).toEqual(codePoints.map(() => true));
  });
});
