import type { BundledSkiaFont } from "./text.native";

// iOS: Skia's CoreText font manager already lists the fonts expo-font registers, so
// diffs find the bundled mono font by name without loading it again. Android loads
// it into Skia itself (bundled-font.android.ts). Web diffs don't use Skia.
export function useBundledSkiaFont(_families: string): BundledSkiaFont | null {
  return null;
}
