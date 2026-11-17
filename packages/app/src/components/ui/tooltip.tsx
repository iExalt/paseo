import { Modal } from "@/components/ui/modal";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Dimensions,
  Platform,
  Pressable,
  View,
  useWindowDimensions,
  type PressableProps,
  type LayoutChangeEvent,
  type ScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { FadeIn, FadeOut, useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Portal } from "@gorhom/portal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardTranslateView, useKeyboardAnchor, useKeyboardShift } from "@/keyboard/shift";
import {
  measureFloatingPanelPortalHost,
  useFloatingPanelPortalHostName,
} from "./floating-panel-portal";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { useShowShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import { Shortcut } from "./shortcut";
import { normalizeDisplayChord } from "./normalize-display-chord";
import { isAnchorVisible, computePosition as computeAnchoredPosition } from "./anchor";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { FloatingSurface } from "@/components/ui/floating";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { isNative, isWeb } from "@/constants/platform";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { holdSurfaceEdge, surfaceFrameStyles, type SurfacePosition } from "./anchor";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TooltipTriggerElement = View | ScrollView | HTMLElement;

interface TooltipContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<TooltipTriggerElement | null>;
  enabled: boolean;
  openOnPress: boolean;
  delayDuration: number;
  held: boolean;
  onAnchorLayout: () => void;
}

const TooltipContext = createContext<TooltipContextValue | null>(null);
const HintEnabledContext = createContext(true);
export const ShortcutHintEnabledProvider = HintEnabledContext.Provider;
const HintLayoutContext = createContext<string | number>(0);
export const ShortcutHintLayoutProvider = HintLayoutContext.Provider;
const HintBoundaryContext = createContext<RefObject<TooltipTriggerElement | null> | null>(null);
export const ShortcutHintBoundaryProvider = HintBoundaryContext.Provider;
const HintClipContext = createContext<RefObject<TooltipTriggerElement | null> | null>(null);
export const ShortcutHintClipProvider = HintClipContext.Provider;

function useTooltipContext(componentName: string): TooltipContextValue {
  const ctx = useContext(TooltipContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <Tooltip />`);
  }
  return ctx;
}

// Tooltips should open on hover or keyboard focus, not when focus is restored
// programmatically (e.g. when a Modal closes and returns focus to its opener).
// Track the last input modality on web so TooltipTrigger can ignore focus
// events that weren't keyboard-driven. Native has no equivalent scenario.
let lastInputWasKeyboard = false;
if (isWeb && typeof window !== "undefined") {
  const markKeyboard = () => {
    lastInputWasKeyboard = true;
  };
  const markPointer = () => {
    lastInputWasKeyboard = false;
  };
  window.addEventListener("keydown", markKeyboard, true);
  window.addEventListener("mousedown", markPointer, true);
  window.addEventListener("pointerdown", markPointer, true);
  window.addEventListener("touchstart", markPointer, true);
}

function shouldOpenOnFocus(): boolean {
  return !isWeb || lastInputWasKeyboard;
}

function isCallable(fn: unknown): fn is (...args: unknown[]) => void {
  return typeof fn === "function";
}

function composeEventHandlers<Event>(
  original: unknown,
  injected: (event: Event) => void,
): (event: Event) => void {
  return (event: Event) => {
    if (isCallable(original)) {
      original(event);
    }
    injected(event);
  };
}

function useControllableOpenState({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}): [boolean, (next: boolean) => void] {
  const [internalOpen, setInternalOpen] = useState(Boolean(defaultOpen));
  const isControlled = typeof open === "boolean";
  const value = isControlled ? open : internalOpen;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return [value, setValue];
}

function measureElement(element: TooltipTriggerElement): Promise<Rect> {
  if (isWeb && element instanceof HTMLElement) {
    const { x, y, width, height } = element.getBoundingClientRect();
    return Promise.resolve({ x, y, width, height });
  }
  if ("measureInWindow" in element) {
    return new Promise((resolve) => {
      element.measureInWindow((x, y, width, height) => {
        resolve({ x, y, width, height });
      });
    });
  }
  throw new Error("A DOM tooltip trigger requires the web platform");
}

function resolveActualSide(args: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  side: Side;
}): Side {
  const { triggerRect, contentSize, displayArea, side } = args;
  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom = displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);
  const spaceLeft = triggerRect.x - displayArea.x;
  const spaceRight = displayArea.x + displayArea.width - (triggerRect.x + triggerRect.width);

  if (side === "bottom" && spaceBottom < contentSize.height && spaceTop > spaceBottom) return "top";
  if (side === "top" && spaceTop < contentSize.height && spaceBottom > spaceTop) return "bottom";
  if (side === "left" && spaceLeft < contentSize.width && spaceRight > spaceLeft) return "right";
  if (side === "right" && spaceRight < contentSize.width && spaceLeft > spaceRight) return "left";
  return side;
}

function resolveAlignedCoordinate(args: {
  align: Align;
  start: number;
  size: number;
  contentSize: number;
}): number {
  const { align, start, size, contentSize } = args;
  if (align === "start") return start;
  if (align === "end") return start + size - contentSize;
  return start + (size - contentSize) / 2;
}

function computePosition({
  triggerRect,
  contentSize,
  displayArea,
  side,
  align,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  side: Side;
  align: Align;
  offset: number;
}): { x: number; y: number; actualSide: Side } {
  const { width: contentWidth, height: contentHeight } = contentSize;
  const actualSide = resolveActualSide({ triggerRect, contentSize, displayArea, side });

  let x = 0;
  let y = 0;

  if (actualSide === "bottom") {
    y = triggerRect.y + triggerRect.height + offset;
    x = resolveAlignedCoordinate({
      align,
      start: triggerRect.x,
      size: triggerRect.width,
      contentSize: contentWidth,
    });
  } else if (actualSide === "top") {
    y = triggerRect.y - contentHeight - offset;
    x = resolveAlignedCoordinate({
      align,
      start: triggerRect.x,
      size: triggerRect.width,
      contentSize: contentWidth,
    });
  } else if (actualSide === "left") {
    x = triggerRect.x - contentWidth - offset;
    y = resolveAlignedCoordinate({
      align,
      start: triggerRect.y,
      size: triggerRect.height,
      contentSize: contentHeight,
    });
  } else {
    x = triggerRect.x + triggerRect.width + offset;
    y = resolveAlignedCoordinate({
      align,
      start: triggerRect.y,
      size: triggerRect.height,
      contentSize: contentHeight,
    });
  }

  const padding = 8;
  x = Math.max(padding, Math.min(displayArea.width - contentWidth - padding, x));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentHeight - padding, y),
  );

  return { x, y, actualSide };
}

export function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  delayDuration = 0,
  enabledOnDesktop = true,
  enabledOnMobile = false,
  children,
  heldShortcut,
  heldSide = "top",
  heldOffset = 8,
  heldHostName,
  heldTestID,
}: PropsWithChildren<{
  heldShortcut?: ShortcutKey[][] | null;
  heldSide?: Side;
  heldOffset?: number;
  heldHostName?: string;
  heldTestID?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  enabledOnDesktop?: boolean;
  enabledOnMobile?: boolean;
}>): ReactElement {
  const triggerRef = useRef<TooltipTriggerElement>(null);
  const [isOpen, setIsOpen] = useControllableOpenState({
    open,
    defaultOpen,
    onOpenChange,
  });

  const isCompact = useIsCompactFormFactor();
  const active = useRetainedPanelActive();
  const scopeEnabled = useContext(HintEnabledContext);
  const showBadges = useShowShortcutBadges();
  const hardwarePresent = useHardwareKeyboardPresent();
  const heldChord = normalizeDisplayChord(heldShortcut ?? undefined);
  const held = active && scopeEnabled && showBadges && hardwarePresent && Boolean(heldChord);
  const [anchorVersion, setAnchorVersion] = useState(0);
  const onAnchorLayout = useCallback(() => {
    if (held) setAnchorVersion((version) => version + 1);
  }, [held]);
  const opensOnPress = isNative || isCompact;
  const enabled = active && (opensOnPress ? enabledOnMobile : enabledOnDesktop);

  // Remove the portal in the inactive commit, before the retained chat freezes.
  // Closing also prevents the tooltip from returning when its panel is shown again.
  useEffect(() => {
    if (!active && isOpen) setIsOpen(false);
  }, [active, isOpen, setIsOpen]);

  const value = useMemo<TooltipContextValue>(
    () => ({
      open: isOpen,
      setOpen: setIsOpen,
      triggerRef,
      enabled,
      openOnPress: opensOnPress,
      delayDuration,
      held,
      onAnchorLayout,
    }),
    [isOpen, setIsOpen, enabled, opensOnPress, delayDuration, held, onAnchorLayout],
  );

  return (
    <TooltipContext.Provider value={value}>
      {children}
      {held && heldChord ? (
        <HeldShortcutBadge
          key={JSON.stringify(heldChord)}
          anchorVersion={anchorVersion}
          anchorRef={triggerRef}
          chord={heldChord}
          side={heldSide}
          offset={heldOffset}
          hostName={heldHostName}
          testID={heldTestID}
        />
      ) : null}
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger({
  children,
  disabled,
  onHoverIn,
  onHoverOut,
  onFocus,
  onBlur,
  onPress,
  onLayout,
  asChild = false,
  triggerRefProp = "ref",
  ...props
}: PressableProps & {
  asChild?: boolean;
  triggerRefProp?: string;
}): ReactElement {
  const ctx = useTooltipContext("TooltipTrigger");
  const setTriggerRef = useCallback(
    (node: View | null) => {
      ctx.triggerRef.current = node;
    },
    [ctx.triggerRef],
  );
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    if (!ctx.enabled || disabled) return;
    clearOpenTimer();
    if (ctx.delayDuration <= 0) {
      ctx.setOpen(true);
      return;
    }
    openTimerRef.current = setTimeout(() => {
      ctx.setOpen(true);
      openTimerRef.current = null;
    }, ctx.delayDuration);
  }, [clearOpenTimer, ctx, disabled]);

  const close = useCallback(() => {
    clearOpenTimer();
    ctx.setOpen(false);
  }, [clearOpenTimer, ctx]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
    };
  }, [clearOpenTimer]);

  useEffect(() => {
    if (!ctx.enabled) clearOpenTimer();
  }, [ctx.enabled, clearOpenTimer]);

  const handleHoverIn = useCallback(
    (e?: unknown) => {
      if (isCallable(onHoverIn)) onHoverIn(e);
      scheduleOpen();
    },
    [onHoverIn, scheduleOpen],
  );

  const handleHoverOut = useCallback(
    (e?: unknown) => {
      if (isCallable(onHoverOut)) onHoverOut(e);
      close();
    },
    [onHoverOut, close],
  );

  const handleFocus = useCallback(
    (e: unknown) => {
      if (isCallable(onFocus)) onFocus(e);
      if (!ctx.enabled || disabled) return;
      if (!shouldOpenOnFocus()) return;
      clearOpenTimer();
      ctx.setOpen(true);
    },
    [clearOpenTimer, ctx, disabled, onFocus],
  );

  const handleBlur = useCallback(
    (e: unknown) => {
      if (isCallable(onBlur)) onBlur(e);
      close();
    },
    [close, onBlur],
  );

  const handlePress = useCallback(
    (e: unknown) => {
      if (isCallable(onPress)) onPress(e);
      if (!ctx.enabled || disabled) {
        return;
      }
      if (ctx.openOnPress) {
        clearOpenTimer();
        ctx.setOpen(true);
        return;
      }
      close();
    },
    [clearOpenTimer, close, ctx, disabled, onPress],
  );

  const handleAnchorLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayout?.(event);
      ctx.onAnchorLayout();
    },
    [onLayout, ctx],
  );
  const triggerProps = {
    ...props,
    disabled,
    onHoverIn: handleHoverIn,
    onHoverOut: handleHoverOut,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onPress: handlePress,
    onLayout: handleAnchorLayout,
    ...(isWeb
      ? ({
          // RN Web's hover handling can vary across environments; pointer events are the most reliable.
          onPointerEnter: handleHoverIn,
          onPointerLeave: handleHoverOut,
          onMouseEnter: handleHoverIn,
          onMouseLeave: handleHoverOut,
        } as object)
      : null),
  };

  if (asChild) {
    const child = Children.only(children);
    if (!isValidElement(child)) {
      throw new Error("TooltipTrigger with asChild expects a single React element child");
    }

    const rawProps: unknown = child.props;
    if (typeof rawProps !== "object" || rawProps === null) {
      throw new Error("TooltipTrigger asChild child must have props object");
    }
    const mergedProps: Record<string, unknown> = {
      ...Object.assign({}, rawProps),
      ...triggerProps,
      disabled: Reflect.get(rawProps, "disabled") || disabled,
      onHoverIn: composeEventHandlers(Reflect.get(rawProps, "onHoverIn"), handleHoverIn),
      onHoverOut: composeEventHandlers(Reflect.get(rawProps, "onHoverOut"), handleHoverOut),
      onFocus: composeEventHandlers(Reflect.get(rawProps, "onFocus"), handleFocus),
      onBlur: composeEventHandlers(Reflect.get(rawProps, "onBlur"), handleBlur),
      onPress: composeEventHandlers(Reflect.get(rawProps, "onPress"), handlePress),
      onLayout: composeEventHandlers(Reflect.get(rawProps, "onLayout"), handleAnchorLayout),
      onPointerEnter: composeEventHandlers(Reflect.get(rawProps, "onPointerEnter"), handleHoverIn),
      onPointerLeave: composeEventHandlers(Reflect.get(rawProps, "onPointerLeave"), handleHoverOut),
      onMouseEnter: composeEventHandlers(Reflect.get(rawProps, "onMouseEnter"), handleHoverIn),
      onMouseLeave: composeEventHandlers(Reflect.get(rawProps, "onMouseLeave"), handleHoverOut),
    };

    const existingRefProp = Reflect.get(rawProps, triggerRefProp);
    mergedProps[triggerRefProp] = (node: TooltipTriggerElement) => {
      if (isCallable(existingRefProp)) {
        existingRefProp(node);
      } else if (existingRefProp && typeof existingRefProp === "object") {
        Object.assign(existingRefProp, { current: node });
      }
      Object.assign(ctx.triggerRef, { current: node });
    };

    return cloneElement(child, mergedProps);
  }

  return (
    <Pressable {...triggerProps} ref={setTriggerRef} collapsable={false}>
      {children}
    </Pressable>
  );
}

export function TooltipContent({
  children,
  side = "top",
  align = "center",
  offset = 6,
  style,
  testID,
  maxWidth = 280,
}: PropsWithChildren<{
  side?: Side;
  align?: Align;
  offset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  maxWidth?: number;
}>): ReactElement | null {
  const ctx = useTooltipContext("TooltipContent");
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<SurfacePosition | null>(null);

  useEffect(() => {
    if (!ctx.open || !ctx.enabled || !ctx.triggerRef.current) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return () => {};
    }

    let cancelled = false;

    void measureElement(ctx.triggerRef.current).then((rect) => {
      if (!cancelled) setTriggerRect(rect);
      return undefined;
    });

    return () => {
      cancelled = true;
    };
  }, [ctx.enabled, ctx.open, ctx.triggerRef]);

  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const displayArea = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    const result = computePosition({
      triggerRect,
      contentSize,
      displayArea,
      side,
      align,
      offset,
    });
    setPosition(
      holdSurfaceEdge(
        { x: result.x, y: result.y, actualPlacement: result.actualSide },
        contentSize.height,
      ),
    );
  }, [triggerRect, contentSize, side, align, offset]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  const frame = useMemo(() => surfaceFrameStyles(position), [position]);
  const frameStyle = useMemo(() => [frame.surface, { maxWidth }], [frame.surface, maxWidth]);
  const contentStyle = useMemo(() => [styles.content, style], [style]);

  const handleDismiss = useCallback(() => ctx.setOpen(false), [ctx]);

  if (!ctx.open || !ctx.enabled || ctx.held) return null;

  // On web, avoid React Native's <Modal/> implementation (it uses <dialog> and can
  // steal focus / disrupt hover). Rendering via Portal + position:fixed keeps the
  // exact same positioning math as DropdownMenu, without hover feedback loops.
  if (isWeb) {
    return createPortal(
      <View pointerEvents="none" style={styles.portalOverlay}>
        <View pointerEvents="box-none" style={frame.holder}>
          <FloatingSurface
            pointerEvents="none"
            entering={FadeIn.duration(80)}
            exiting={FadeOut.duration(80)}
            collapsable={false}
            role="tooltip"
            testID={testID}
            onLayout={handleLayout}
            style={contentStyle}
            frameStyle={frameStyle}
          >
            {children}
          </FloatingSurface>
        </View>
      </View>,
      getOverlayRoot(),
    );
  }

  return (
    <Modal
      visible={ctx.open}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={handleDismiss}
    >
      <Pressable testID="tooltip-dismiss" style={styles.overlay} onPress={handleDismiss}>
        <View pointerEvents="box-none" style={frame.holder}>
          <FloatingSurface
            pointerEvents="none"
            entering={FadeIn.duration(80)}
            exiting={FadeOut.duration(80)}
            collapsable={false}
            role="tooltip"
            testID={testID}
            onLayout={handleLayout}
            style={contentStyle}
            frameStyle={frameStyle}
          >
            {children}
          </FloatingSurface>
        </View>
      </Pressable>
    </Modal>
  );
}

/** Passive decoration: never creates a modal, registers an overlay, or takes focus. */
function HeldShortcutBadge({
  anchorRef,
  anchorVersion,
  chord,
  side,
  offset,
  hostName,
  testID,
}: {
  anchorRef: RefObject<TooltipTriggerElement | null>;
  anchorVersion: number;
  chord: ShortcutKey[][];
  side: Side;
  offset: number;
  hostName?: string;
  testID?: string;
}) {
  "use no memo";
  const ownerLayout = useContext(HintLayoutContext);
  const boundaryRef = useContext(HintBoundaryContext);
  const clipRef = useContext(HintClipContext);
  const inheritedHost = useFloatingPanelPortalHostName();
  const selectedHost = hostName ?? inheritedHost;
  const windowSize = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const anchor = useKeyboardAnchor();
  const { measureAtRest } = anchor;
  const { isMoving } = useKeyboardShift();
  const [rect, setRect] = useState<Rect | null>(null);
  const [hostRect, setHostRect] = useState<Rect | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const generation = useRef(0);
  const remeasure = useCallback(() => {
    const element = anchorRef.current;
    if (!element) return;
    const current = generation.current;
    let clipMeasurement: Promise<Rect | null> = Promise.resolve(null);
    const clipElement = clipRef?.current;
    if (clipElement)
      clipMeasurement = isWeb ? measureElement(clipElement) : measureAtRest(clipElement as View);
    let boundaryMeasurement: Promise<Rect | null> = Promise.resolve(null);
    const boundaryElement = boundaryRef?.current;
    if (boundaryElement)
      boundaryMeasurement = isWeb
        ? measureElement(boundaryElement)
        : measureAtRest(boundaryElement as View);
    void Promise.all([
      isWeb ? measureElement(element) : measureAtRest(element as View),
      isWeb
        ? Promise.resolve({ x: 0, y: 0, width: windowSize.width, height: windowSize.height })
        : measureFloatingPanelPortalHost(selectedHost),
      boundaryMeasurement,
      clipMeasurement,
    ]).then(([nextRect, nextHost, boundary, clip]) => {
      if (current !== generation.current || !nextRect || !nextHost) return undefined;
      if (!isAnchorVisible(nextRect, nextHost) || (clip && !isAnchorVisible(nextRect, clip))) {
        setRect(null);
        return undefined;
      }
      setRect(
        boundary && side === "top"
          ? { ...nextRect, y: Math.min(nextRect.y, boundary.y) }
          : nextRect,
      );
      setHostRect(nextHost);
      return undefined;
    });
  }, [
    anchorRef,
    boundaryRef,
    clipRef,
    side,
    measureAtRest,
    selectedHost,
    windowSize.width,
    windowSize.height,
  ]);
  useEffect(() => {
    generation.current += 1;
    setRect(null);
    remeasure();
    const raf = requestAnimationFrame(remeasure);
    let observer: ResizeObserver | undefined;
    if (isWeb) {
      window.addEventListener("scroll", remeasure, true);
      if (anchorRef.current instanceof HTMLElement) {
        observer = new ResizeObserver(remeasure);
        observer.observe(anchorRef.current);
      }
    }
    return () => {
      generation.current += 1;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      if (isWeb) window.removeEventListener("scroll", remeasure, true);
    };
  }, [remeasure, ownerLayout, anchorRef, anchorVersion]);
  useAnimatedReaction(
    () => isMoving.value,
    (moving, previous) => {
      if (previous && !moving) scheduleOnRN(remeasure);
    },
    [isMoving, remeasure],
  );
  const position =
    rect && size && hostRect
      ? computeAnchoredPosition({
          triggerRect: rect,
          contentSize: size,
          displayArea: {
            x: Math.max(hostRect.x, insets.left),
            y: Math.max(hostRect.y, insets.top),
            width: Math.min(hostRect.width, windowSize.width - insets.left - insets.right),
            height: Math.min(hostRect.height, windowSize.height - insets.top - insets.bottom),
          },
          placement: side,
          alignment: "center",
          offset,
        })
      : null;
  const handleBadgeLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) =>
      previous?.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);
  if (!rect || !hostRect) return null;
  const badge = (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: OVERLAY_Z.tooltip }]}>
      <View
        pointerEvents="none"
        testID={testID ?? "held-shortcut-badge"}
        onLayout={handleBadgeLayout}
        style={[
          styles.heldBadge,
          {
            maxWidth: windowSize.width - 16,
            opacity: position && hostRect ? 1 : 0,
            left: position && hostRect ? position.x - hostRect.x : 0,
            top: position && hostRect ? position.y - hostRect.y : 0,
          },
        ]}
      >
        <Shortcut chord={chord} />
      </View>
    </View>
  );
  if (isWeb) return createPortal(badge, getOverlayRoot());
  return (
    <Portal hostName={selectedHost}>
      <KeyboardTranslateView
        {...anchor.translation}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        {badge}
      </KeyboardTranslateView>
    </Portal>
  );
}

const styles = StyleSheet.create((theme) => ({
  heldBadge: {
    position: "absolute",
    backgroundColor: theme.colors.popover,
    borderRadius: theme.borderRadius.md,
    zIndex: OVERLAY_Z.tooltip,
  },
  overlay: { flex: 1 },
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: OVERLAY_Z.tooltip,
  },
  content: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
    zIndex: 1000,
  },
}));
