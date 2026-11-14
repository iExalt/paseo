import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import {
  holdMessage,
  waitForHeldMessage,
  type HeldDispatchResult,
  type HeldMessageController,
} from "./held-messages.js";

const AGENT_ID = "held-agent";

class FakeManager {
  agent: {
    id: string;
    lifecycle: string;
    activeTurnId: string | null;
    pendingPermissions: Map<string, unknown>;
  } | null = {
    id: AGENT_ID,
    lifecycle: "running",
    activeTurnId: "turn-1",
    pendingPermissions: new Map(),
  };
  private subscriber: ((event: AgentManagerEvent) => void) | null = null;

  readonly controller: HeldMessageController = {
    getAgent: () => this.agent as unknown as ManagedAgent | null,
    hasInFlightRun: () => this.agent?.lifecycle === "running",
    subscribe: (callback) => {
      this.subscriber = callback;
      return () => {
        this.subscriber = null;
      };
    },
  };

  get subscribed(): boolean {
    return this.subscriber !== null;
  }

  endTurn(type: "turn_completed" | "turn_failed" | "turn_canceled", turnId = "turn-1"): void {
    this.agent = {
      id: AGENT_ID,
      lifecycle: "idle",
      activeTurnId: null,
      pendingPermissions: this.agent?.pendingPermissions ?? new Map(),
    };
    this.subscriber?.({
      type: "agent_stream",
      agentId: AGENT_ID,
      event: { type, provider: "codex", turnId } as never,
    });
  }

  startTurn(turnId: string): void {
    this.agent = {
      id: AGENT_ID,
      lifecycle: "running",
      activeTurnId: turnId,
      pendingPermissions: new Map(),
    };
    this.emitState();
  }

  close(): void {
    this.agent = {
      id: AGENT_ID,
      lifecycle: "closed",
      activeTurnId: null,
      pendingPermissions: new Map(),
    };
    this.emitState();
  }

  resolvePermissions(): void {
    this.agent?.pendingPermissions.clear();
    this.emitState();
  }

  private emitState(): void {
    this.subscriber?.({ type: "agent_state", agent: this.agent as unknown as ManagedAgent });
  }
}

function hold(
  manager: FakeManager,
  name: string,
  delivered: string[],
  options: {
    kind?: "deferred" | "queued";
    turnId?: string;
    dispatch?: () => Promise<HeldDispatchResult>;
  } = {},
): void {
  holdMessage(
    manager.controller,
    AGENT_ID,
    {
      kind: options.kind ?? "deferred",
      turnId: options.turnId ?? "turn-1",
      messageId: name,
      dispatch:
        options.dispatch ??
        (async () => {
          // Like a provider that cannot steer: a running turn sends the message back.
          const busyTurn = manager.agent?.activeTurnId;
          if (busyTurn) return { kind: "busy", turnId: busyTurn };
          delivered.push(name);
          manager.startTurn(`${name}-turn`);
          return { kind: "settled" };
        }),
    },
    createTestLogger(),
  );
}

test("releases held messages one turn at a time in the order they arrived", async () => {
  const manager = new FakeManager();
  const delivered: string[] = [];
  hold(manager, "a", delivered);
  hold(manager, "b", delivered);

  manager.endTurn("turn_completed");
  await expect(waitForHeldMessage(manager.controller, AGENT_ID, "a")).resolves.toBe("dispatched");
  expect(delivered).toEqual(["a"]);

  manager.endTurn("turn_completed", "a-turn");
  await expect(waitForHeldMessage(manager.controller, AGENT_ID, "b")).resolves.toBe("dispatched");
  expect(delivered).toEqual(["a", "b"]);
  expect(manager.subscribed).toBe(false);
});

test("a head that meets another busy turn keeps its place ahead of later messages", async () => {
  const manager = new FakeManager();
  const delivered: string[] = [];
  let declines = 1;
  hold(manager, "a", delivered, {
    dispatch: async () => {
      if (declines-- > 0) {
        manager.startTurn("autonomous-turn");
        return { kind: "busy", turnId: "autonomous-turn" };
      }
      delivered.push("a");
      manager.startTurn("a-turn");
      return { kind: "settled" };
    },
  });
  hold(manager, "b", delivered);

  manager.endTurn("turn_completed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivered).toEqual([]);

  manager.endTurn("turn_completed", "autonomous-turn");
  await expect(waitForHeldMessage(manager.controller, AGENT_ID, "a")).resolves.toBe("dispatched");
  expect(delivered).toEqual(["a"]);
});

test("canceling a turn discards the steers deferred behind it but keeps queued messages", async () => {
  const manager = new FakeManager();
  const delivered: string[] = [];
  hold(manager, "deferred", delivered);
  hold(manager, "queued", delivered, { kind: "queued" });
  const deferred = waitForHeldMessage(manager.controller, AGENT_ID, "deferred");
  const queued = waitForHeldMessage(manager.controller, AGENT_ID, "queued");

  manager.endTurn("turn_canceled");
  await expect(deferred).resolves.toBe("discarded");
  await expect(queued).resolves.toBe("dispatched");
  expect(delivered).toEqual(["queued"]);
});

test("closing the agent discards held messages, including one being dispatched", async () => {
  const manager = new FakeManager();
  const delivered: string[] = [];
  let finishDispatch!: () => void;
  hold(manager, "a", delivered, {
    dispatch: () =>
      new Promise((_resolve, reject) => {
        finishDispatch = () => reject(new Error("agent closed"));
      }),
  });
  hold(manager, "b", delivered);
  const a = waitForHeldMessage(manager.controller, AGENT_ID, "a");
  const b = waitForHeldMessage(manager.controller, AGENT_ID, "b");

  manager.endTurn("turn_completed");
  manager.close();
  finishDispatch();
  await expect(a).resolves.toBe("discarded");
  await expect(b).resolves.toBe("discarded");
  expect(delivered).toEqual([]);
});

test("a held message settles only after its dispatch registers a run", async () => {
  const manager = new FakeManager();
  let registerRun!: () => void;
  hold(manager, "a", [], {
    dispatch: () =>
      new Promise((resolve) => {
        registerRun = () => {
          manager.startTurn("a-turn");
          resolve({ kind: "settled" });
        };
      }),
  });
  const outcome = waitForHeldMessage(manager.controller, AGENT_ID, "a");
  let settled = false;
  void outcome?.finally(() => {
    settled = true;
  });

  manager.endTurn("turn_completed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);

  registerRun();
  await expect(outcome).resolves.toBe("dispatched");
  expect(manager.agent?.activeTurnId).toBe("a-turn");
});

test("a queued message waits for a permission that outlived its turn", async () => {
  const manager = new FakeManager();
  const delivered: string[] = [];
  manager.agent?.pendingPermissions.set("permission-1", {});
  hold(manager, "queued", delivered, { kind: "queued" });

  manager.endTurn("turn_completed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivered).toEqual([]);

  manager.resolvePermissions();
  await expect(waitForHeldMessage(manager.controller, AGENT_ID, "queued")).resolves.toBe(
    "dispatched",
  );
  expect(delivered).toEqual(["queued"]);
});

test("a message the daemon is not holding has nothing to wait for", () => {
  expect(waitForHeldMessage(new FakeManager().controller, AGENT_ID, "unknown")).toBeNull();
});
