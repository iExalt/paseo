/** @vitest-environment jsdom */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  getDesktopDaemonStatus: bridge.status,
  shouldUseDesktopDaemon: () => true,
}));
import { useIsLocalDaemon } from "./use-is-local-daemon";
afterEach(cleanup);
it.each(["failed", "upgrading"])(
  "recognizes the local host on first mount during stopped %s",
  async (phase) => {
    bridge.status.mockResolvedValue({
      serverId: "",
      status: "stopped",
      desktopManaged: false,
      pid: null,
      startedAt: null,
      upgrade: {
        serverId: "local",
        phase,
        pid: 42,
        startedAt: "old",
        targetVersion: "0.23.0",
        error: null,
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useIsLocalDaemon("local"), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    unmount();
    client.clear();
  },
);
