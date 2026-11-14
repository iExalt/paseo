import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { PushPayload } from "./index.js";

test("actual daemon RPCs keep question and attention episodes independent across two clients", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-rpc-"));
  const sent: PushPayload[] = [];
  const fixture = await createTestPaseoDaemon({
    relayEnabled: false,
    paseoHomeRoot: path.join(home, "daemon"),
    pushNotificationSender: {
      send: async (payload) => {
        sent.push(payload);
      },
    },
  });
  const config = {
    url: `ws://127.0.0.1:${fixture.port}/ws`,
    appVersion: "0.26.0",
    clientType: "cli" as const,
  };
  const device = new DaemonClient(config);
  const other = new DaemonClient(config);
  try {
    await device.connect();
    await other.connect();
    expect(device.getLastServerInfoMessage()?.features?.androidNotificationLifecycle).toBe(true);
    const agent = await other.createAgent({
      provider: "claude",
      modeId: "bypassPermissions",
      cwd: home,
      title: "Finished fixture",
    });
    await other.sendMessage(agent.id, "Say done");
    await other.waitForFinish(agent.id, 15000);
    const [a] = await device.syncNotificationLifecycle();
    expect(a).toBeTruthy();
    await other.clearAgentAttention(agent.id);
    expect(await device.syncNotificationLifecycle()).toEqual([]);
    await other.sendMessage(agent.id, "Say done again");
    await other.waitForFinish(agent.id, 15000);
    const [b] = await device.syncNotificationLifecycle();
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
    const question = await other.createAgent({
      provider: "claude",
      modeId: "default",
      cwd: home,
      title: "Question fixture",
    });
    await other.sendMessage(question.id, "Use your shell tool to run: `echo hello`.");
    const pending = await other.waitForFinish(question.id, 15000);
    expect(pending.status).toBe("permission");
    const requestId = pending.final!.pendingPermissions![0]!.id;
    const both = await device.syncNotificationLifecycle();
    expect(both).toHaveLength(2);
    const q = both.find((id) => id !== b)!;
    await other.clearAgentAttention(question.id);
    expect(await device.syncNotificationLifecycle()).toContain(q);
    await other.respondToPermission(question.id, requestId, { behavior: "deny", interrupt: true });
    await other.waitForFinish(question.id, 15000);
    expect(await device.syncNotificationLifecycle()).toEqual([b]);
    await expect.poll(() => sent.some((payload) => payload.lifecycle?.episodeId === q)).toBe(true);
    const beforeError = sent.length;
    await other.sendMessage(agent.id, "Emit a turn failure");
    await other.waitForFinish(agent.id, 15000);
    expect(await device.syncNotificationLifecycle()).toEqual([b]);
    expect(sent.length).toBe(beforeError);
    await other.clearAgentAttention(agent.id);
    expect(await device.syncNotificationLifecycle()).toEqual([]);
    expect(
      sent
        .filter((payload) => payload.data?.reason === "finished")
        .every((payload) => payload.lifecycle?.lane === "attention"),
    ).toBe(true);
  } finally {
    await device.close();
    await other.close();
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
