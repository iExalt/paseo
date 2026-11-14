/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("@/utils/app-visibility", () => ({ getIsAppActivelyVisible: () => true }));
vi.mock("@/constants/platform", () => ({ isWeb: false }));

import { useAgentAttentionClear } from "./use-agent-attention-clear";

interface Props {
  isConnected: boolean;
  requiresAttention: boolean | undefined;
}

function setup(initialProps: Props) {
  const clearAgentAttention = vi.fn(async () => undefined);
  const client = { clearAgentAttention } as unknown as DaemonClient;
  const hook = renderHook(
    (props: Props) =>
      useAgentAttentionClear({
        agentId: "agent",
        client,
        attentionReason: "finished",
        isScreenFocused: true,
        ...props,
      }),
    { initialProps },
  );
  return { ...hook, clearAgentAttention };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentAttentionClear", () => {
  it("marks a thread read when it was opened before its host connected", () => {
    // Cold start from a notification: the thread has focus, then the host connects,
    // then the directory reports the turn that ended while the app was closed.
    const { rerender, clearAgentAttention } = setup({
      isConnected: false,
      requiresAttention: undefined,
    });
    rerender({ isConnected: true, requiresAttention: undefined });
    expect(clearAgentAttention).not.toHaveBeenCalled();
    rerender({ isConnected: true, requiresAttention: true });
    expect(clearAgentAttention).toHaveBeenCalledTimes(1);
  });

  it("still leaves a turn that ends while the thread is watched unread", () => {
    vi.useFakeTimers();
    const { rerender, clearAgentAttention } = setup({
      isConnected: true,
      requiresAttention: false,
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender({ isConnected: true, requiresAttention: true });
    expect(clearAgentAttention).not.toHaveBeenCalled();
  });
});
