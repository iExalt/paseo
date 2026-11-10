import { useRef } from "react";
import { View } from "react-native";

/** Web readers do not extend under a native system bar. */
export function useReaderBottomInset() {
  return { ref: useRef<View>(null), onLayout: undefined, bottomPadding: 0 };
}
