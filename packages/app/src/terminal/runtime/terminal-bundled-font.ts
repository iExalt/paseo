import { namesTerminalNerdFont, TERMINAL_NERD_FONT_FAMILY } from "./terminal-font";

// Served from packages/app/public, so web exports, the daemon web UI and the
// desktop app:// handler all carry them, and native bundles never do.
const BUNDLED_FONT_FACES = [
  { url: "/fonts/meslolgs-nf/meslolgs-nf-regular.woff2?v=nf-3.5.1", weight: "400" },
  { url: "/fonts/meslolgs-nf/meslolgs-nf-bold.woff2?v=nf-3.5.1", weight: "700" },
] as const;

let bundledFontLoad: Promise<boolean> | null = null;
let bundledFontLoaded = false;
// By weight. A face that fails to load is dropped, so the next registration
// retries it while the faces that loaded stay.
const registeredFaces = new Map<string, FontFace>();

// Declares the faces without fetching them: the browser downloads a face the first
// time text asks for the family, so code surfaces get the font without app startup
// paying for it. Returns no faces where FontFace doesn't exist (native, tests).
export function registerBundledMonoFont(): FontFace[] {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
    return [];
  }
  for (const face of BUNDLED_FONT_FACES) {
    if (registeredFaces.has(face.weight)) {
      continue;
    }
    const fontFace = new FontFace(TERMINAL_NERD_FONT_FAMILY, `url(${face.url}) format("woff2")`, {
      weight: face.weight,
      display: "swap",
    });
    document.fonts.add(fontFace);
    registeredFaces.set(face.weight, fontFace);
  }
  return [...registeredFaces.values()];
}

function dropFace(weight: string): void {
  const face = registeredFaces.get(weight);
  if (face) {
    document.fonts.delete(face);
    registeredFaces.delete(weight);
  }
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
    const faces = registerBundledMonoFont();
    if (faces.length === 0) {
      return false;
    }
    const results = await Promise.allSettled(faces.map((face) => face.load()));
    let failed = false;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failed = true;
        dropFace(faces[index]!.weight);
      }
    });
    // A later mount retries what failed, e.g. after the network comes back.
    if (failed) {
      bundledFontLoad = null;
    }
    // The terminal needs Regular. Without Bold the browser synthesizes it from
    // Regular at the same advance width, so cells still line up.
    bundledFontLoaded = registeredFaces.get("400")?.status === "loaded";
    return bundledFontLoaded;
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
  for (const face of registeredFaces.values()) {
    document.fonts.delete(face);
  }
  registeredFaces.clear();
}
