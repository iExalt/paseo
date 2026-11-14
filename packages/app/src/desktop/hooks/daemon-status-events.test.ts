import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
const events = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@/desktop/electron/events", () => ({ listenToDesktopEvent: events.listen }));
import { DAEMON_STATUS_QUERY_KEY, retainDaemonStatusEvents } from "./daemon-status-events";

describe("daemon upgrade subscription", () => {
  it("shares one listener, invalidates real cached status, and waits for the last consumer to unmount", async () => {
    const dispose = vi.fn();
    events.listen.mockResolvedValue(dispose);
    const client = new QueryClient();
    client.setQueryData(DAEMON_STATUS_QUERY_KEY, { status: { version: "0.22.0" } });
    const first = retainDaemonStatusEvents(client);
    const second = retainDaemonStatusEvents(client);
    expect(events.listen).toHaveBeenCalledOnce();
    expect(client.getQueryState(DAEMON_STATUS_QUERY_KEY)?.isInvalidated).toBe(false);
    events.listen.mock.calls[0]![1]({});
    expect(client.getQueryState(DAEMON_STATUS_QUERY_KEY)?.isInvalidated).toBe(true);
    first();
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    second();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    client.clear();
  });
});
