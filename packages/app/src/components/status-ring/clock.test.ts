/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A minimal shared value: the clock only needs `value` and listeners. Worklets run inline.
vi.mock("react-native-reanimated", async () => {
  const { useState } = await vi.importActual<typeof import("react")>("react");
  function makeMutable<T>(initial: T) {
    const listeners = new Map<number, (value: T) => void>();
    let current = initial;
    return {
      get value() {
        return current;
      },
      set value(next: T) {
        current = next;
        for (const listener of listeners.values()) listener(next);
      },
      addListener: (id: number, listener: (value: T) => void) => listeners.set(id, listener),
      removeListener: (id: number) => listeners.delete(id),
    };
  }
  return {
    makeMutable,
    useSharedValue: <T>(initial: T) => useState(() => makeMutable(initial))[0],
  };
});
vi.mock("react-native-worklets", () => ({
  scheduleOnUI: (worklet: (...args: unknown[]) => void, ...args: unknown[]) => worklet(...args),
}));

// Vitest resolves "./clock" to clock.web.ts; load the native clock by its file name.
const NATIVE_CLOCK = "./clock.ts";
const { useStatusRingRotation } = (await import(NATIVE_CLOCK)) as typeof import("./clock");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "requestAnimationFrame"] });
});

afterEach(() => {
  vi.useRealTimers();
});

function advanceFrames(ms: number): void {
  vi.advanceTimersByTime(ms);
}

it("turns a ring only while its panel is active", () => {
  const { result, rerender, unmount } = renderHook(({ active }) => useStatusRingRotation(active), {
    initialProps: { active: false },
  });
  const hiddenAngle = result.current.value;

  advanceFrames(100);
  expect(result.current.value).toBe(hiddenAngle);

  rerender({ active: true });
  advanceFrames(100);
  const turning = result.current.value;
  expect(turning).not.toBe(hiddenAngle);

  rerender({ active: false });
  advanceFrames(100);
  expect(result.current.value).toBe(turning);
  unmount();
});

it("keeps a hidden ring still while a visible ring keeps the clock running", () => {
  const visible = renderHook(() => useStatusRingRotation(true));
  const hidden = renderHook(() => useStatusRingRotation(false));
  const hiddenAngle = hidden.result.current.value;

  advanceFrames(100);

  expect(visible.result.current.value).not.toBe(hiddenAngle);
  expect(hidden.result.current.value).toBe(hiddenAngle);
  visible.unmount();
  hidden.unmount();
});
