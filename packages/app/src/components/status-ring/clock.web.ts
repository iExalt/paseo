import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import type { View as NativeView } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

const STATUS_RING_KEYFRAMES: PropertyIndexedKeyframes = {
  transform: ["rotate(0deg)", "rotate(360deg)"],
};
const STATUS_RING_TIMING: KeyframeAnimationOptions = {
  duration: STATUS_RING_PERIOD_MS,
  easing: "linear",
  iterations: Number.POSITIVE_INFINITY,
};
const STATUS_RING_TIMELINE_START_MS = 0;

export function useStatusRingAnimationRef(): RefCallback<NativeView> {
  const arcElement = useRef<HTMLElement | null>(null);
  const setArcElement = useCallback((instance: NativeView | null) => {
    arcElement.current = instance instanceof HTMLElement ? instance : null;
  }, []);
  // Under reduced motion the ring stays a still arc, like SyncedLoader's dots.
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const element = arcElement.current;
    if (!element || reduceMotion) {
      return;
    }

    const animation = element.animate(STATUS_RING_KEYFRAMES, STATUS_RING_TIMING);
    animation.startTime = STATUS_RING_TIMELINE_START_MS;
    return () => {
      animation.cancel();
    };
  }, [reduceMotion]);

  return setArcElement;
}
