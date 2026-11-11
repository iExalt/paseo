import { namesTerminalNerdFont, TERMINAL_NERD_FONT_FAMILY } from "./terminal-font";

// Served from packages/app/public, so web exports, the daemon web UI and the
// desktop app:// handler all carry them, and native bundles never do.
const BUNDLED_FONT_FACES = [
  { url: "/fonts/meslolgs-nf/meslolgs-nf-regular.woff2?v=nf-3.5.1", weight: "400" },
  { url: "/fonts/meslolgs-nf/meslolgs-nf-bold.woff2?v=nf-3.5.1", weight: "700" },
] as const;

let bundledFontLoad: Promise<boolean> | null = null;
let bundledFontLoaded = false;
let registeredFaces: FontFace[] | null = null;

// Declares the faces without fetching them: the browser downloads a face the first
// time text asks for the family, so code surfaces get the font without app startup
// paying for it. Returns null where FontFace doesn't exist (native, tests).
export function registerBundledMonoFont(): FontFace[] | null {
  if (registeredFaces) {
    return registeredFaces;
  }
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
    return null;
  }
  const faces = BUNDLED_FONT_FACES.map(
    (face) =>
      new FontFace(TERMINAL_NERD_FONT_FAMILY, `url(${face.url}) format("woff2")`, {
        weight: face.weight,
        display: "swap",
      }),
  );
  for (const face of faces) {
    document.fonts.add(face);
  }
  registeredFaces = faces;
  return faces;
}

export function isBundledTerminalFontLoaded(): boolean {
  return bundledFontLoaded;
}

// An unused @font-face is never fetched, so document.fonts.ready can resolve
// before the font is even requested. Load the faces explicitly instead, and only
// once a terminal mounts so app startup doesn't pay for them.
export function loadBundledTerminalFont(): Promise<boolean> {
  if (bundledFontLoad) {
    return bundledFontLoad;
  }
  bundledFontLoad = (async () => {
    let faces: FontFace[] = [];
    try {
      faces = registerBundledMonoFont() ?? [];
      if (faces.length === 0) {
        return false;
      }
      await Promise.all(faces.map((face) => face.load()));
      bundledFontLoaded = true;
      return true;
    } catch {
      // All or nothing: drop a face that did load so the family stays absent,
      // and let a later mount retry, e.g. after the network comes back.
      for (const face of faces) {
        document.fonts.delete(face);
      }
      registeredFaces = null;
      bundledFontLoad = null;
      return false;
    }
  })();
  return bundledFontLoad;
}

// xterm measures cells once per font change. Measuring while the bundled font is
// still downloading would size cells from a fallback, so leave it out until it
// has loaded and then switch, which xterm treats as a font change.
export function withoutBundledTerminalFont(fontFamily: string): string {
  const families = fontFamily
    .split(",")
    .map((family) => family.trim())
    .filter((family) => family.length > 0 && !namesTerminalNerdFont(family));
  return families.length > 0 ? families.join(", ") : "monospace";
}

export function resetBundledTerminalFontForTest(): void {
  bundledFontLoad = null;
  bundledFontLoaded = false;
  registeredFaces = null;
}
