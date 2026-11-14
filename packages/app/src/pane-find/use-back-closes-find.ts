import { useEffect } from "react";
import { BackHandler } from "react-native";

/**
 * Android Back closes an open find bar before it leaves the pane. Pass `enabled`
 * only while the bar is open in the visible, focused pane: a retained hidden pane
 * that kept its listener would swallow Back with nothing on screen changing.
 */
export function useBackClosesFind(enabled: boolean, close: () => void): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close, enabled]);
}
