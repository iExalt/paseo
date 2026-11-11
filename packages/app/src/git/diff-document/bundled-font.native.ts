import { useSyncExternalStore } from "react";
import { Image } from "react-native";
import { Skia } from "@shopify/react-native-skia";
import { TERMINAL_NERD_FONT_FAMILY } from "@/terminal/runtime/terminal-font";
import type { BundledSkiaFont } from "./text.native";

// Skia's Android font manager lists only system fonts, not the ones expo-font embeds,
// so the diff surface loads the bundled mono font into its own provider. It loads
// once per process; until then, diffs draw with the system mono font.
let font: BundledSkiaFont | null = null;
let loading = false;
const listeners = new Set<() => void>();

async function loadFont(): Promise<BundledSkiaFont> {
  const { uri } = Image.resolveAssetSource(
    require("../../../assets/fonts/meslolgs-nf/meslolgs_nf_regular.ttf"),
  );
  const typeface = Skia.Typeface.MakeFreeTypeFaceFromData(await Skia.Data.fromURI(uri));
  if (!typeface) throw new Error("bundled mono font did not parse");
  const provider = Skia.TypefaceFontProvider.Make();
  provider.registerFont(typeface, TERMINAL_NERD_FONT_FAMILY);
  return { family: TERMINAL_NERD_FONT_FAMILY, typeface, provider };
}

function subscribe(listener: () => void): () => void {
  if (!loading) {
    loading = true;
    loadFont()
      .then((loaded) => {
        font = loaded;
        for (const notify of listeners) notify();
        return undefined;
      })
      .catch((error: unknown) => {
        console.warn("[diff] could not load the bundled mono font", error);
      });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const subscribeNever = () => () => {};

/** The bundled mono font as a Skia font, once loaded, when `families` names it. */
export function useBundledSkiaFont(families: string): BundledSkiaFont | null {
  const wanted = families.includes(TERMINAL_NERD_FONT_FAMILY);
  return useSyncExternalStore(wanted ? subscribe : subscribeNever, () => (wanted ? font : null));
}
