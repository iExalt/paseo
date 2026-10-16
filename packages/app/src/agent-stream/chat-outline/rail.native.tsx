import { memo, useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { railIndexAt } from "./model";
import type { ChatOutlineRailProps } from "./rail";

// The same footprint as the web rail, so it shows only where the transcript leaves room.
const RAIL_WIDTH = 36;
const SLOT_HEIGHT = 8;
const MIN_PANEL_WIDTH = 918;
const PILL_HEIGHT = 2;
const RESTING_PILL_WIDTH = 10;
const ACTIVE_PILL_WIDTH = 18;
const TOUCHED_PILL_WIDTH = 26;
const PREVIEW_WIDTH = 260;
const PREVIEW_HEIGHT = 48;
const PREVIEW_GAP = 4;

/**
 * The outline for touch. Ticks are too small to aim at, so the whole rail is one target:
 * a finger on it previews the prompt under it, sliding moves the preview, and lifting
 * jumps there. Touch has no hover, so nothing magnifies ahead of the finger.
 */
export const ChatOutlineRail = memo(function ChatOutlineRail({
  prompts,
  activePrompt,
  onJumpToPrompt,
}: ChatOutlineRailProps) {
  const isCompact = useIsCompactFormFactor();
  const activeSeq = useSyncExternalStore(activePrompt.subscribe, activePrompt.getActiveSeq);
  const { onLayout, isBelow: isPanelNarrow } = useContainerWidthBelow(MIN_PANEL_WIDTH);
  const [touchedIndex, setTouchedIndex] = useState<number | null>(null);
  const rail = useRef<View>(null);
  const bounds = useRef({ top: 0, height: 0 });

  const measureRail = useCallback(() => {
    rail.current?.measureInWindow((_x, top, _width, height) => {
      bounds.current = { top, height };
    });
  }, []);
  const indexAt = useCallback(
    (event: GestureResponderEvent) =>
      railIndexAt({
        y: event.nativeEvent.pageY - bounds.current.top,
        height: bounds.current.height,
        count: prompts.length,
        slotHeight: SLOT_HEIGHT,
      }),
    [prompts.length],
  );
  const handleGrant = useCallback(
    (event: GestureResponderEvent) => {
      measureRail();
      setTouchedIndex(indexAt(event));
    },
    [indexAt, measureRail],
  );
  const handleMove = useCallback(
    (event: GestureResponderEvent) => setTouchedIndex(indexAt(event)),
    [indexAt],
  );
  const handleRelease = useCallback(
    (event: GestureResponderEvent) => {
      const prompt = prompts[indexAt(event)];
      setTouchedIndex(null);
      if (prompt) onJumpToPrompt(prompt.seq);
    },
    [indexAt, onJumpToPrompt, prompts],
  );
  const handleTerminate = useCallback(() => setTouchedIndex(null), []);

  if (isCompact || prompts.length < 2) return null;
  return (
    <View style={styles.panelMeasure} pointerEvents="box-none" onLayout={onLayout}>
      {isPanelNarrow ? null : (
        <View
          ref={rail}
          style={styles.rail}
          onLayout={measureRail}
          onStartShouldSetResponder={returnTrue}
          // Keep the touch when the finger slides vertically, so the transcript does not scroll.
          onResponderTerminationRequest={returnFalse}
          onResponderGrant={handleGrant}
          onResponderMove={handleMove}
          onResponderRelease={handleRelease}
          onResponderTerminate={handleTerminate}
          accessibilityRole="adjustable"
          testID="chat-outline-rail"
        >
          {prompts.map((prompt, index) => (
            <View key={prompt.seq} style={styles.slot}>
              <View
                style={[
                  styles.pill,
                  prompt.seq === activeSeq && styles.pillActive,
                  index === touchedIndex && styles.pillTouched,
                ]}
              />
              {index === touchedIndex ? (
                <View style={styles.preview} pointerEvents="none">
                  <Text style={styles.previewText} numberOfLines={2}>
                    {prompt.preview}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
});

function returnTrue() {
  return true;
}

function returnFalse() {
  return false;
}

const styles = StyleSheet.create((theme) => ({
  panelMeasure: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  rail: {
    position: "absolute",
    left: theme.spacing[2],
    top: "10%",
    bottom: "10%",
    width: RAIL_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  slot: {
    width: RAIL_WIDTH,
    flexBasis: SLOT_HEIGHT,
    flexShrink: 1,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingLeft: theme.spacing[1],
  },
  pill: {
    width: RESTING_PILL_WIDTH,
    height: PILL_HEIGHT,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.borderAccent,
  },
  pillActive: { width: ACTIVE_PILL_WIDTH, backgroundColor: theme.colors.foregroundExtraMuted },
  pillTouched: { width: TOUCHED_PILL_WIDTH, backgroundColor: theme.colors.foreground },
  preview: {
    position: "absolute",
    left: RAIL_WIDTH + PREVIEW_GAP,
    top: "50%",
    marginTop: -PREVIEW_HEIGHT / 2,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    ...theme.shadow.md,
  },
  previewText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
