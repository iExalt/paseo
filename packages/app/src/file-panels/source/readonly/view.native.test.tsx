// @vitest-environment jsdom
import React, { useImperativeHandle } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { FileSourceView } from "./view.native";

interface ListProps {
  onScrollToIndexFailed: (info: { index: number; averageItemLength: number }) => void;
  onContentSizeChange: (width: number, height: number) => void;
  onViewableItemsChanged: (info: { viewableItems: Array<{ index: number | null }> }) => void;
  onScrollBeginDrag: () => void;
}

const list = vi.hoisted(() => ({
  props: {} as ListProps,
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
}));
vi.mock("react-native", () => ({
  FlatList: ({ ref, ...props }: ListProps & { ref: React.Ref<unknown> }) => {
    list.props = props;
    useImperativeHandle(ref, () => list);
    return null;
  },
  Text: () => null,
  View: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("../../loading", () => ({ FilePanelLoading: () => null }));
vi.mock("./source-lines", () => ({
  buildSourceLines: ({ content }: { content: string }, report: (lines: unknown[]) => void) => {
    report(content.split("\n").map((text) => [{ text, style: null }]));
    return () => {};
  },
}));

const props: ComponentProps<typeof FileSourceView> = {
  content: Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n"),
  filename: "guide.md",
  location: { path: "guide.md", lineStart: 450 },
  navigationRevision: 0,
  presentation: "plain",
  theme: {} as ComponentProps<typeof FileSourceView>["theme"],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("native source line navigation", () => {
  it("keeps a distant reveal pending until its row is measured and visible", () => {
    list.scrollToIndex.mockImplementationOnce(() => {
      list.props.onScrollToIndexFailed({ index: 449, averageItemLength: 35 });
    });
    render(<FileSourceView {...props} />);
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 449 * 35, animated: false });
    act(() => list.props.onContentSizeChange(375, 18000));
    expect(list.scrollToIndex).toHaveBeenLastCalledWith({
      index: 449,
      animated: false,
      viewPosition: 0.5,
    });
    const beforeVisible = list.scrollToIndex.mock.calls.length;
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ index: 448 }] }));
    expect(list.scrollToIndex).toHaveBeenCalledTimes(beforeVisible + 1);
    act(() => list.props.onViewableItemsChanged({ viewableItems: [{ index: 449 }] }));
    const calls = list.scrollToIndex.mock.calls.length;
    act(() => list.props.onViewableItemsChanged({ viewableItems: [] }));
    expect(list.scrollToIndex).toHaveBeenCalledTimes(calls);
  });

  it("cancels a pending line reveal when the reader starts dragging", () => {
    list.scrollToIndex.mockImplementationOnce(() => {
      list.props.onScrollToIndexFailed({ index: 449, averageItemLength: 35 });
    });
    render(<FileSourceView {...props} />);
    const calls = list.scrollToIndex.mock.calls.length;
    act(() => list.props.onScrollBeginDrag());
    act(() => list.props.onContentSizeChange(375, 18000));
    expect(list.scrollToIndex).toHaveBeenCalledTimes(calls);
  });
});
