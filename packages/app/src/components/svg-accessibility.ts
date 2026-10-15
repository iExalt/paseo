import { isWeb } from "@/constants/platform";

// react-native-svg spreads its props onto <svg> on web, where the native-only
// accessibility props are unknown DOM attributes and React warns about them.
export const svgHiddenFromAccessibility = isWeb
  ? ({ "aria-hidden": true } as const)
  : ({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    } as const);
