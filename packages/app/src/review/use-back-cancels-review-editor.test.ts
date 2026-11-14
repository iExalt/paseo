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

import { useBackCancelsReviewEditor } from "./use-back-cancels-review-editor";

describe("useBackCancelsReviewEditor", () => {
  it("cancels the editor on Back only while it is open in the active panel", () => {
    const cancel = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ editorOpen, panelActive }) => useBackCancelsReviewEditor(editorOpen, panelActive, cancel),
      { initialProps: { editorOpen: false, panelActive: true } },
    );
    expect(listeners.size).toBe(0);

    rerender({ editorOpen: true, panelActive: true });
    expect([...listeners].map((handler) => handler())).toEqual([true]);
    expect(cancel).toHaveBeenCalledTimes(1);

    rerender({ editorOpen: true, panelActive: false });
    expect(listeners.size).toBe(0);

    rerender({ editorOpen: false, panelActive: true });
    expect(listeners.size).toBe(0);
    unmount();
  });
});
