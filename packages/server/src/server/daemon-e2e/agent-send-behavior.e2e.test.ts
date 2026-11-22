import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PARENT_AGENT_ID_LABEL, parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import pino from "pino";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

// The deterministic Codex provider cannot steer, so a steer is held like a queued message, and a
// prompt mentioning sleep runs a 250 ms shell call. A blocking send must report the turn its own
// message ran in, not the turn it was held behind.
test("waiting on a held send follows the message it sent", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const agent = await client.createAgent({
      provider: "codex",
      cwd: daemon.paseoHome,
      title: "Held send",
      modeId: "full-access",
    });
    for (const behavior of ["steer", "queue"] as const) {
      await client.sendMessage(agent.id, "run sleep in the shell");
      const messageId = randomUUID();
      const dispatch = await client.sendAgentMessage(
        agent.id,
        "run sleep in the shell, then say 'state saved'",
        {
          activeTurnBehavior: behavior,
          messageId,
        },
      );
      expect(dispatch.disposition).toBe(behavior === "queue" ? "queued" : undefined);
      const state = await client.waitForFinish(agent.id, 20_000, { messageId });
      expect(state.status).toBe("idle");
      expect(state.lastMessage).toContain("state saved");
    }
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

// An agent's send waits two quiet seconds before dispatch, so the first turn stays open until the
// daemon logs the follow-up as held behind it.
test("a held send notifies its caller when its own turn finishes", async () => {
  const notifications: string[] = [];
  const firstTurn = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const daemon = await createTestPaseoDaemon({
    logger: pino(
      { level: "info" },
      {
        write: (line: string) => {
          if (line.includes('"agent.held_message.held"')) held.resolve();
        },
      },
    ),
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        if (String(prompt).includes('kind="agent-notification"'))
          notifications.push(String(prompt));
      },
      beforeTurnComplete: async (prompt) => {
        if (String(prompt).includes("First task")) await firstTurn.promise;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const create = (title: string) =>
      client.createAgent({
        provider: "codex",
        cwd: daemon.paseoHome,
        title,
        modeId: "full-access",
      });
    const caller = await create("Caller");
    const agent = await create("Held send");
    await client.sendMessage(agent.id, "First task");
    await client.sendAgentMessage(agent.id, "say 'state saved'", {
      sourceAgentId: caller.id,
      notifyOnFinish: true,
    });
    await held.promise;
    firstTurn.resolve();
    await expect.poll(() => notifications.length, { timeout: 20_000 }).toBe(1);
    expect(notifications[0]).toContain("state saved");
  } finally {
    firstTurn.resolve();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("omitted finish notifications only subscribe the recipient's parent", async () => {
  const notifications: string[] = [];
  const finishTask = Promise.withResolvers<void>();
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        if (String(prompt).includes('kind="agent-notification"'))
          notifications.push(String(prompt));
      },
      beforeTurnComplete: async (prompt) => {
        if (String(prompt).includes("Delegated task")) await finishTask.promise;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const create = (title: string, labels?: Record<string, string>) =>
      client.createAgent({ provider: "codex", cwd: daemon.paseoHome, title, labels });
    const parent = await create("Parent");
    const child = await create("Child", { [PARENT_AGENT_ID_LABEL]: parent.id });
    const detached = await create("Detached");
    const before = await client.sendAgentMessage(child.id, "Delegated task", {
      sourceAgentId: parent.id,
    });
    expect(before.deliveryStatus).toBe("queued");

    await client.sendAgentMessage(parent.id, "Child status report", { sourceAgentId: child.id });
    await client.sendAgentMessage(parent.id, "Detached status report", {
      sourceAgentId: detached.id,
    });
    await client.sendAgentMessage(child.id, "No callback requested", {
      sourceAgentId: parent.id,
      notifyOnFinish: false,
    });
    const records = JSON.parse(
      await readFile(join(daemon.paseoHome, "finish-subscriptions.json"), "utf8"),
    );
    expect(records).toEqual([
      expect.objectContaining({
        callerAgentId: parent.id,
        childAgentId: child.id,
        requireParentOwnership: true,
      }),
    ]);
    finishTask.resolve();
    await expect.poll(() => notifications, { timeout: 10_000 }).toHaveLength(1);
    expect(notifications[0]).toContain(`source-agent-id="${child.id}"`);
  } finally {
    finishTask.resolve();
    await client.close();
    await daemon.close();
  }
}, 30_000);

test("connected-host sends subscribe only for direct children unless explicitly requested", async () => {
  const catalogs = new Map<string, PaseoToolCatalog>();
  const notifications: string[] = [];
  const finishTask = Promise.withResolvers<void>();
  const agentClients = createTestAgentClients({
    onLaunchContext: (context) => {
      if (context?.agentId && context.paseoTools) catalogs.set(context.agentId, context.paseoTools);
    },
    onStartTurn: (prompt) => {
      if (String(prompt).includes('kind="agent-notification"')) notifications.push(String(prompt));
    },
  });
  agentClients.codex!.capabilities.supportsNativePaseoTools = true;
  const origin = await createTestPaseoDaemon({ agentClients });
  const remote = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: () => finishTask.promise,
    }),
  });
  const caller = new DaemonClient({ url: `ws://127.0.0.1:${origin.port}/ws` });
  const recipient = new DaemonClient({ url: `ws://127.0.0.1:${remote.port}/ws` });
  try {
    await caller.connect();
    await recipient.connect();
    await caller.addHost({ connection: `127.0.0.1:${remote.port}` });
    await expect.poll(async () => (await caller.listHosts()).hosts[0]?.status).toBe("online");
    const parent = await caller.createAgent({ provider: "codex", cwd: origin.paseoHome });
    const parentAddress = { agentId: parent.id, serverId: origin.daemon.getServerId() };
    const remoteId = remote.daemon.getServerId();
    const child = await recipient.createAgent({
      provider: "codex",
      cwd: remote.paseoHome,
      labels: parentAddressLabels(parentAddress),
    });
    const peer = await recipient.createAgent({
      provider: "codex",
      cwd: remote.paseoHome,
      labels: parentAddressLabels({ ...parentAddress, serverId: remoteId }),
    });

    const catalog = catalogs.get(parent.id);
    if (!catalog) throw new Error("Provider launch did not receive the caller's tool catalog");
    const send = (agentId: string, notifyOnFinish?: boolean) =>
      catalog.executeTool("send_agent_prompt", {
        agentId,
        serverId: remoteId,
        prompt: "Remote task",
        ...(notifyOnFinish !== undefined ? { notifyOnFinish } : {}),
      });
    expect((await send(child.id)).structuredContent).toMatchObject({
      deliveryStatus: "queued",
      guidance: expect.stringContaining("You will get notified"),
    });
    expect((await send(peer.id)).structuredContent).toMatchObject({
      deliveryStatus: "queued",
      guidance: expect.stringContaining("Observe completion"),
    });
    expect((await send(peer.id, true)).structuredContent).toMatchObject({
      deliveryStatus: "queued",
      guidance: expect.stringContaining("You will get notified"),
    });
    expect((await send(child.id, false)).structuredContent).toMatchObject({
      deliveryStatus: "queued",
      guidance: expect.stringContaining("Observe completion"),
    });

    const records = JSON.parse(
      await readFile(join(origin.paseoHome, "finish-subscriptions.json"), "utf8"),
    );
    expect(records).toEqual([
      expect.objectContaining({
        callerAgentId: parent.id,
        childAgentId: child.id,
        serverId: remoteId,
        requireParentOwnership: true,
      }),
      expect.objectContaining({
        callerAgentId: parent.id,
        childAgentId: peer.id,
        serverId: remoteId,
        requireParentOwnership: false,
      }),
    ]);
    finishTask.resolve();
    await expect.poll(() => notifications.join("\n"), { timeout: 10_000 }).toContain(child.id);
    await expect.poll(() => notifications.join("\n"), { timeout: 10_000 }).toContain(peer.id);
  } finally {
    finishTask.resolve();
    await Promise.all([caller.close(), recipient.close()]);
    await Promise.all([origin.close(), remote.close()]);
  }
}, 30_000);
