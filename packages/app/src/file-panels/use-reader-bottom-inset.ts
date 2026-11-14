import { useRef } from "react";
import { View } from "react-native";

/** Web readers do not extend under a native system bar. */
export function useReaderBottomInset() {
  // Keep the hook call out of the returned literal: React Compiler memoizes the
  // literal on first render, which skipped useRef on later renders and crashed the
  // Markdown preview with "Should have a queue".
  const ref = useRef<View>(null);
  return { ref, onLayout: undefined, bottomPadding: 0 };
}
