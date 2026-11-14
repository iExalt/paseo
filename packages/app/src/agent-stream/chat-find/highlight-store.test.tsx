/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  setChatFindHighlight,
  useChatFindItemHighlight,
  useChatFindMessageSelected,
} from "./highlight-store";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

describe("chat find highlight store", () => {
  it("re-renders only the rows whose selection or occurrence changes", () => {
    const renders: Record<string, number> = { a1: 0, a2: 0, b: 0 };
    function Row({ id, messageId }: { id: string; messageId: string }) {
      renders[id] += 1;
      useChatFindMessageSelected(messageId);
      useChatFindItemHighlight(id);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <>
          <Row id="a1" messageId="a" />
          <Row id="a2" messageId="a" />
          <Row id="b" messageId="b" />
        </>,
      ),
    );
    act(() => setChatFindHighlight({ messageId: "a", itemId: "a1", query: "x", index: 0 }));
    act(() => setChatFindHighlight({ messageId: "a", itemId: "a1", query: "x", index: 1 }));
    act(() => setChatFindHighlight({ messageId: "a", itemId: "a2", query: "x", index: 0 }));
    act(() => setChatFindHighlight({ messageId: "b", itemId: "b", query: "x", index: 0 }));
    // a1: select, next occurrence, lose it, lose the message; a2: select, gain, lose.
    expect(renders).toEqual({ a1: 5, a2: 4, b: 2 });
    act(() => root.unmount());
  });
});
