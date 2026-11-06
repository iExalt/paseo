// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite otherwise resolves the web implementation first.
const { ZoomableViewport } = await vi.importActual<typeof import("./index")>("./index.tsx");

type GestureEvent = Record<string, number>;
interface TestGesture {
  kind: string;
  config: Record<string, number | boolean>;
  handlers: Record<string, (event: GestureEvent) => void>;
}
const harness = vi.hoisted(() => ({
  gestures: [] as TestGesture[],
  animated: [] as Array<() => { transform: Array<Record<string, number>> }>,
  layout: null as null | ((event: unknown) => void),
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    onLayout,
  }: {
    children?: React.ReactNode;
    onLayout?: typeof harness.layout;
  }) => {
    if (onLayout) harness.layout = onLayout;
    return React.createElement("div", null, children);
  },
}));
vi.mock("./toolbar", () => ({ ViewportToolbar: () => null }));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: React.ReactNode }) => children },
  runOnJS: (callback: unknown) => callback,
  useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
  useAnimatedStyle: (style: (typeof harness.animated)[number]) => {
    harness.animated.push(style);
    return {};
  },
}));
vi.mock("react-native-gesture-handler", () => {
  const build = (kind: string) => {
    const entry: TestGesture = { kind, config: {}, handlers: {} };
    harness.gestures.push(entry);
    const builtGesture = new Proxy(
      {},
      {
        get: (_target, name: string) => (value: unknown) => {
          if (name.startsWith("on"))
            entry.handlers[name] = value as TestGesture["handlers"][string];
          else entry.config[name] = value as number | boolean;
          return builtGesture;
        },
      },
    );
    return builtGesture;
  };
  return {
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    Gesture: {
      Pan: () => build("pan"),
      Pinch: () => build("pinch"),
      Tap: () => build("tap"),
      Simultaneous: (...gestures: unknown[]) => gestures,
      Exclusive: (...gestures: unknown[]) => gestures,
    },
  };
});

let root: Root;
let container: HTMLDivElement;
const CONTENT_SIZE = { width: 1600, height: 1200 };
beforeEach(() => {
  harness.gestures.length = 0;
  harness.animated.length = 0;
  harness.layout = null;
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  act(() =>
    root.render(
      <ZoomableViewport contentSize={CONTENT_SIZE} minScale={1}>
        <div />
      </ZoomableViewport>,
    ),
  );
  expect(harness.layout).not.toBeNull();
  act(() => harness.layout?.({ nativeEvent: { layout: { width: 800, height: 600 } } }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function gesture(kind: string): TestGesture {
  const found = harness.gestures.findLast((entry) => entry.kind === kind);
  if (!found) throw new Error(`Missing ${kind} gesture`);
  return found;
}
function transform() {
  const transforms = harness.animated.flatMap((style) => style().transform);
  const read = (key: string) => {
    const entry = transforms.findLast((value) => key in value);
    if (!entry) throw new Error(`Missing ${key} transform`);
    return entry[key];
  };
  return { x: read("translateX"), y: read("translateY"), scale: read("scale") };
}
function pinch(factor: number) {
  const { handlers } = gesture("pinch");
  handlers.onBegin({ numberOfPointers: 2 });
  handlers.onTouchesDown({ numberOfTouches: 2 });
  handlers.onUpdate({ numberOfPointers: 2, scale: factor, focalX: 400, focalY: 300 });
}
function startPan() {
  const { handlers, config } = gesture("pan");
  handlers.onBegin?.({});
  let translationX = 0;
  let translationY = 0;
  let failed = false;
  return (changeX: number, changeY: number, numberOfPointers = 1) => {
    translationX += changeX;
    translationY += changeY;
    // RNGH fails a recognizer whose configured pointer maximum is exceeded.
    if (typeof config.maxPointers === "number" && numberOfPointers > config.maxPointers)
      failed = true;
    if (failed) return;
    const update = handlers.onChange ?? handlers.onUpdate;
    update({ changeX, changeY, translationX, translationY, numberOfPointers });
  };
}

describe("native image panning", () => {
  it("reverses immediately after overshooting a clamped edge", () => {
    pinch(2);
    const move = startPan();
    move(1000, 800);
    expect(transform()).toEqual({ x: 400, y: 300, scale: 2 });
    move(-30, -40);
    expect(transform()).toEqual({ x: 370, y: 260, scale: 2 });
  });

  it("keeps the pan active through a pinch and continues with the remaining finger", () => {
    pinch(2);
    const move = startPan();
    move(40, 30);
    move(0, 0, 2);
    pinch(1.25);
    const zoomed = transform();
    gesture("pinch").handlers.onTouchesUp({ numberOfTouches: 1 });
    move(60, 40);
    expect(transform()).toEqual({ x: zoomed.x + 60, y: zoomed.y + 40, scale: zoomed.scale });
  });
});
