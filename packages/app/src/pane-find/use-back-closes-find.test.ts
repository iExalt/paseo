/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { listeners } = vi.hoisted(() => ({ listeners: new Set<() => boolean>() }));
vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      listeners.add(handler);
      return { remove: () => listeners.delete(handler) };
    },
  },
}));

import { useBackClosesFind } from "./use-back-closes-find";

describe("useBackClosesFind", () => {
  it("handles Back only while enabled", () => {
    const close = vi.fn();
    const { rerender, unmount } = renderHook(({ enabled }) => useBackClosesFind(enabled, close), {
      initialProps: { enabled: false },
    });
    expect(listeners.size).toBe(0);

    rerender({ enabled: true });
    expect([...listeners].map((handler) => handler())).toEqual([true]);
    expect(close).toHaveBeenCalledTimes(1);

    // An open bar in a pane that is hidden or lost focus leaves Back to the rest.
    rerender({ enabled: false });
    expect(listeners.size).toBe(0);
    unmount();
  });
});
