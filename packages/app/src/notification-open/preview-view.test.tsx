// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { receiveNotificationPreview, useNotificationReceipt } from "./preview";

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("@/assistant-file-links", () => ({
  AssistantFileLinkResolverProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { NotificationPreviewFallback } from "./preview-view";

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession("preview-host");
  useNotificationReceipt.setState({ receipt: null });
});

it("retains the only visible message until the canonical chat surface takes over", () => {
  useSessionStore.getState().initializeSession("preview-host", null as unknown as DaemonClient);
  receiveNotificationPreview("preview-host", "agent", "tap", {
    preview: {
      v: 1,
      kind: "assistant",
      epoch: "epoch",
      seqStart: 1,
      seqEnd: 5,
      timestamp: "2026-11-06T00:00:00.000Z",
      text: "Latest notification content",
      truncated: false,
    },
  });
  const rendered = render(
    <NotificationPreviewFallback serverId="preview-host" agentId="agent">
      <div>Preparing workspace</div>
    </NotificationPreviewFallback>,
  );
  expect(screen.getByText("Latest notification content")).toBeTruthy();
  act(() =>
    useSessionStore.getState().applyAgentTimelineResponseState("preview-host", "agent", {
      items: [],
      head: [],
      range: { epoch: "epoch", startSeq: 1, endSeq: 5 },
      older: "none",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    }),
  );
  expect(screen.getByText("Preparing workspace")).toBeTruthy();
  expect(screen.getByText("Latest notification content")).toBeTruthy();
  rendered.rerender(<div>Canonical conversation content</div>);
  expect(screen.queryByTestId("notification-preview-fallback")).toBeNull();
  expect(screen.getByText("Canonical conversation content")).toBeTruthy();
});
