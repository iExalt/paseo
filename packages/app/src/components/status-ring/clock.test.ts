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



});
