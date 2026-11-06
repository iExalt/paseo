import { describe, expect, it, vi } from "vitest";
import { createNotificationOpenRouter, parseNotificationOpenTarget } from "./model";
import type { NotificationOpenSource, NotificationTap } from "./source";

class FakeSource implements NotificationOpenSource {
  listeners = new Set<(tap: NotificationTap) => void>();
  acknowledged: string[] = [];
  launchReads = 0;
  constructor(readonly launch: NotificationTap | null) {}
  subscribe(onTap: (tap: NotificationTap) => void) {
    this.listeners.add(onTap);
    return () => {
      this.listeners.delete(onTap);
    };
  }
  async takeLaunchTap() {
    this.launchReads++;
    return this.launch;
  }
  acknowledge(tap: NotificationTap) {
    this.acknowledged.push(tap.id);
  }
  tap(tap: NotificationTap) {
    for (const listener of this.listeners) listener(tap);
  }
}
const launch: NotificationTap = {
  id: "one",
  data: { serverId: "host", workspaceId: "stale", agentId: "agent" },
};
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("notification open", () => {
  it.each([
    [undefined, null],
    [null, null],
    [[], null],
    [{ agentId: "a" }, null],
    [{ serverId: " " }, null],
    [{ serverId: " h " }, { kind: "host", serverId: "h" }],
    [
      { serverId: "h", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
    [
      { serverId: "h", workspaceId: "stale", agentId: "a" },
      { kind: "agent", serverId: "h", agentId: "a" },
    ],
    [
      { serverId: "h", workspaceId: "w", terminalId: "t", agentId: "a" },
      { kind: "terminal", serverId: "h", workspaceId: "w", terminalId: "t" },
    ],
  ])("parses %j", (data, expected) => {
    expect(parseNotificationOpenTarget(data)).toEqual(expected);
  });

  function setup(whenReadyToNavigate = () => Promise.resolve()) {
    const source = new FakeSource(launch);
    const agents: unknown[] = [];
    const routes: string[] = [];
    const terminals: unknown[] = [];
    const cancelPreparation = vi.fn();
    const prepareAgent = vi.fn(() => cancelPreparation);
    const router = createNotificationOpenRouter({
      source,
      prepareAgent,
      openAgent: (target) => {
        agents.push(target);
      },
      openTerminal: (target) => {
        terminals.push(target);
      },
      openRoute: (route) => {
        routes.push(route);
      },
      whenReadyToNavigate,
    });
    return { source, agents, routes, terminals, router, prepareAgent, cancelPreparation };
  }

  it("takes the launch tap once across remounts", async () => {
    const { source, agents, router } = setup();
    router.start()();
    const stop = router.start();
    await flush();
    expect(source.launchReads).toBe(1);
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    stop();
  });

  it("ignores listener replay of the launch tap after remount", async () => {
    const { source, agents, router } = setup();
    const stop = router.start();
    await flush();
    stop();
    const stopAgain = router.start();
    source.tap(launch);
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.acknowledged).toEqual(["one"]);
    stopAgain();
  });

  it("waits for readiness before dispatch and acknowledgement", async () => {
    let ready = () => {};
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { source, agents, router, prepareAgent } = setup(() => readiness);
    const stop = router.start();
    await flush();
    expect(agents).toEqual([]);
    expect(prepareAgent).toHaveBeenCalledExactlyOnceWith({
      kind: "agent",
      serverId: "host",
      agentId: "agent",
    });
    expect(source.acknowledged).toEqual([]);
    ready();
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.acknowledged).toEqual(["one"]);
    stop();
  });

  it("supersedes a queued tap without letting replay reclaim navigation", async () => {
    let ready = () => {};
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { source, agents, router, prepareAgent, cancelPreparation } = setup(() => gate);
    const stop = router.start();
    await flush();
    source.tap({ id: "two", data: { serverId: "host", agentId: "second" } });
    source.tap(launch);
    expect(cancelPreparation).toHaveBeenCalledTimes(1);
    expect(prepareAgent).toHaveBeenCalledTimes(2);
    ready();
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "second" }]);
    expect(source.acknowledged).toEqual(["one", "two"]);
    stop();
  });

  it("still navigates and acknowledges if preparation throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, agents, router, prepareAgent } = setup();
    prepareAgent.mockImplementation(() => {
      throw new Error("cache unavailable");
    });
    const stop = router.start();
    await flush();
    expect(agents).toEqual([{ serverId: "host", agentId: "agent" }]);
    expect(source.acknowledged).toEqual(["one"]);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
    stop();
  });

  it("acknowledges each distinct tap including invalid targets", async () => {
    const { source, agents, router } = setup();
    const stop = router.start();
    await flush();
    source.tap({ id: "two", data: { serverId: "host", agentId: "second" } });
    source.tap({ id: "invalid", data: undefined });
    await flush();
    expect(agents).toEqual([
      { serverId: "host", agentId: "agent" },
      { serverId: "host", agentId: "second" },
    ]);
    expect(source.acknowledged).toEqual(["one", "two", "invalid"]);
    stop();
  });

  it("dispatches terminals and hosts through their navigation capabilities", async () => {
    const { source, routes, terminals, router } = setup();
    const stop = router.start();
    source.tap({
      id: "terminal",
      data: { serverId: "host", workspaceId: "ws", terminalId: "term" },
    });
    await flush();
    source.tap({ id: "host", data: { serverId: "host" } });
    await flush();
    expect(routes).toEqual(["/h/host"]);
    expect(terminals).toEqual([
      { kind: "terminal", serverId: "host", workspaceId: "ws", terminalId: "term" },
    ]);
    stop();
  });

  it("does not let a delayed launch response replace a newer live tap", async () => {
    let launchReady = (_tap: NotificationTap) => {};
    const source = new FakeSource(null);
    source.takeLaunchTap = () =>
      new Promise<NotificationTap>((resolve) => {
        launchReady = resolve;
      });
    const openAgent = vi.fn();
    const router = createNotificationOpenRouter({
      source,
      prepareAgent: () => () => {},
      openAgent,
      openRoute: () => {},
      openTerminal: () => {},
      whenReadyToNavigate: async () => {},
    });
    const stop = router.start();
    source.tap({ id: "new", data: { serverId: "host", agentId: "new" } });
    launchReady(launch);
    await flush();
    expect(openAgent).toHaveBeenCalledExactlyOnceWith({ serverId: "host", agentId: "new" });
    expect(source.acknowledged).toEqual(["new", "one"]);
    stop();
  });
});
