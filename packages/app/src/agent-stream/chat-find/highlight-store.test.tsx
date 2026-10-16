/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { setChatFindHighlight, useChatFindHighlight } from "./highlight-store";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

describe("useChatFindHighlight", () => {
  it("re-renders only the rows whose highlight changes", () => {
    const renders: Record<string, number> = { a: 0, b: 0, c: 0 };
    function Row({ id }: { id: string }) {
      renders[id] += 1;
      useChatFindHighlight(id);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <>
          <Row id="a" />
          <Row id="b" />
          <Row id="c" />
        </>,
      ),
    );
    act(() => setChatFindHighlight({ messageId: "a", query: "x", occurrence: 0 }));
    act(() => setChatFindHighlight({ messageId: "a", query: "x", occurrence: 1 }));
    act(() => setChatFindHighlight({ messageId: "b", query: "x", occurrence: 0 }));
    expect(renders).toEqual({ a: 4, b: 2, c: 1 });
    act(() => root.unmount());
  });
});
