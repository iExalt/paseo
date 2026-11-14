// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadHook(clock: string | undefined) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_PASEO_AGENT_SWITCHES", "1");
  vi.doMock("@/diagnostics/agent-switches", () => ({
    readAgentSwitch: (key: string) => (key === "clock" ? clock : undefined),
  }));
  return (await import("./live-elapsed")).useLiveElapsedMs;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock("@/diagnostics/agent-switches");
});

describe("useLiveElapsedMs", () => {
  it("ticks every second by default", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const useLiveElapsedMs = await loadHook(undefined);
    const { result } = renderHook(() => useLiveElapsedMs(0, true));

    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current).toBe(12_000);
  });

  it("stops ticking with clock=frozen but still shows a fresh value on the next render", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const useLiveElapsedMs = await loadHook("frozen");
    const { result, rerender } = renderHook(({ start }) => useLiveElapsedMs(start, true), {
      initialProps: { start: 0 },
    });

    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current).toBe(10_000);

    rerender({ start: 11_000 });
    expect(result.current).toBe(1_000);
  });
});
