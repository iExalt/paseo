import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useWindowDimensions } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readerBottomOverlap } from "./reader-bottom-overlap";

export function useReaderBottomInset() {
  const ref = useRef<View>(null);
  const generation = useRef(0);
  const [bottomPadding, setBottomPadding] = useState(0);
  const { height: windowHeight } = useWindowDimensions();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const measure = useCallback(() => {
    const current = ref.current;
    const request = ++generation.current;
    current?.measureInWindow((_x, frameTop, _width, frameHeight) => {
      if (generation.current !== request) return;
      setBottomPadding(readerBottomOverlap({ frameTop, frameHeight, windowHeight, bottomInset }));
    });
  }, [bottomInset, windowHeight]);
  useEffect(() => {
    measure();
    return () => {
      generation.current += 1;
    };
  }, [measure]);
  return { ref, onLayout: measure, bottomPadding };
}
