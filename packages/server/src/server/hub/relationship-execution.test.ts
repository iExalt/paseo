import { afterEach, describe, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

describe("Hub relationship owned execution", () => {
  let relationship: HubRelationshipHarness | null = null;

  afterEach(async () => {
    await relationship?.close();
    relationship = null;
  });

  test("daemon restart reconnects the same durable relationship", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    const id = relationship.relationshipFile()?.relationship.daemonId;
    relationship.connectLatestSocket();
    await relationship.socketDialed();

    await relationship.restartDaemon();
    await relationship.socketDialed();

    expect(relationship.relationshipFile()?.relationship.daemonId).toBe(id);
    expect(relationship.socketAttempts()).toBe(2);
  });

  test("daemon restart closes an interrupted owned turn without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const daemonId = relationship.relationshipFile()?.relationship.daemonId;
    const prompt = "sleep 30";
    relationship.beginOwnedCreate("running-create", "execution-running", {
      prompt,
      modeId: "full-access",
    });
    const created = await relationship.ownedCreateResult("running-create");
    const running = await relationship.ownedRunningUpdate(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("running-duplicate", "execution-running", { prompt });
    const duplicate = await relationship.ownedCreateResult("running-duplicate");
    expect(duplicate).toMatchObject({
      payload: {
        success: true,
        executionId: "execution-running",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(running).toMatchObject({
      executionId: "execution-running",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "running" },
    });
    expect(relationship.relationshipFile()?.relationship.daemonId).toBe(daemonId);
    expect(durableAgentIds).toEqual([created.payload.agentId]);
    expect(relationship.executionProviderCreations()).toBe(1);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("an owned execution does not persist a daemon-restart prompt intent", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("intent-create", "execution-intent", { prompt: "sleep 30" });
    await relationship.ownedCreateResult("intent-create");

    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
  });

  test("an ordinary duplicate create does not replay a completed owned turn", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "respond with exactly: completed once";
    relationship.beginOwnedCreate("completed-create", "execution-completed", { prompt });
    const created = await relationship.ownedCreateResult("completed-create");
    await relationship.ownedTurnCompletion(created.payload.agentId!);

    relationship.beginOwnedCreate("completed-duplicate", "execution-completed", { prompt });
    const duplicate = await relationship.ownedCreateResult("completed-duplicate");

    expect(duplicate).toMatchObject({
      type: "hub.execution.agent.create.response",
      payload: {
        success: true,
        executionId: "execution-completed",
        agentId: created.payload.agentId,
        agent: { status: "idle" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(await relationship.durableOwnedAgentIds()).toEqual([created.payload.agentId]);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(1);
  });

  test("daemon restart closes a completed owned session without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "respond with exactly: already completed";
    relationship.beginOwnedCreate("idle-create", "execution-idle", { prompt });
    const created = await relationship.ownedCreateResult("idle-create");
    await relationship.ownedTurnCompletion(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("idle-retry", "execution-idle", { prompt });
    const retried = await relationship.ownedCreateResult("idle-retry");

    expect(retried).toMatchObject({
      payload: {
        executionId: "execution-idle",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("daemon restart closes a failed owned session without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "emit a turn failure";
    relationship.beginOwnedCreate("failed-create", "execution-failed", { prompt });
    const created = await relationship.ownedCreateResult("failed-create");
    const failed = await relationship.ownedTurnFailure(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("failed-retry", "execution-failed", { prompt });
    const retried = await relationship.ownedCreateResult("failed-retry");

    expect(failed).toMatchObject({
      executionId: "execution-failed",
      agentId: created.payload.agentId,
      event: { type: "turn_failed" },
    });
    expect(retried).toMatchObject({
      payload: {
        executionId: "execution-failed",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("Hub revocation leaves no execution intent artifacts", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("revoked-create", "execution-revoked", { prompt: "sleep 30" });
    await relationship.ownedCreateResult("revoked-create");

    relationship.rejectRelationship(401);

    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
  });

  test("stale socket generations cannot replace or unregister the current socket", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.closeSocket(0, 1006);
    await relationship.retry();
    relationship.connectSocket(1);

    relationship.connectSocket(0);
    relationship.closeSocket(0, 1000);
    const messages = relationship.sendHubRequestOnLatest({
      type: "daemon.get_status.request",
      requestId: "still-current",
    });

    expect(messages).toContainEqual({
      type: "rpc_error",
      payload: {
        requestId: "still-current",
        requestType: "daemon.get_status.request",
        error: "Session is not authorized for daemon.get_status.request",
        code: "access_denied",
      },
    });
    expect(relationship.socketAttempts()).toBe(2);
  });

  test("replayed create across socket generations shares one pending durable execution", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("first-create");
    await relationship.agentCreationAttempts(1);

    relationship.closeLatestSocket(1006);
    await relationship.retry();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("replayed-create");
    relationship.finishAgentCreation();

    const replayed = await relationship.ownedCreateResult("replayed-create");
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(relationship.socketDeliveredResponse(0, "first-create")).toBe(false);
    expect(replayed).toMatchObject({
      type: "hub.execution.agent.create.response",
      payload: {
        success: true,
        executionId: "execution-race",
        agentId: durableAgentIds[0],
      },
    });
    expect(relationship.executionProviderCreations()).toBe(1);
    expect(durableAgentIds).toHaveLength(1);
  });

  test("idempotent retry waits for a pending create across socket generations", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("pending-create", "pending-execution");
    await relationship.agentCreationAttempts(1);

    relationship.closeLatestSocket(1006);
    await relationship.retry();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("pending-retry", "pending-execution");
    relationship.finishAgentCreation();

    await expect(relationship.ownedCreateResult("pending-retry")).resolves.toMatchObject({
      payload: {
        executionId: "pending-execution",
        agentId: expect.any(String),
        agent: { id: expect.any(String) },
      },
    });
    expect(relationship.executionProviderCreations()).toBe(1);
    expect(await relationship.durableOwnedAgentIds()).toHaveLength(1);
  });

  test("force disconnect fences a pending create before removing authority", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("cancelled-create", "cancelled-execution", {
      worktree: { mode: "branch-off", newBranch: "cancelled-hub-create" },
    });
    await relationship.agentCreationAttempts(1);

    const disconnecting = relationship.beginDisconnect(true);
    await relationship.relationshipStateBecomes(null);
    relationship.finishAgentCreation();
    await disconnecting.result;

    expect(relationship.activeOwnedAgentIds()).toEqual([]);
    expect(await relationship.durableOwnedAgentIds()).toEqual([]);
    expect(await relationship.listedWorktrees()).toHaveLength(1);
  });

  test("re-enrollment gives the same daemon fresh execution authority", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("first-create", "first-execution");
    const first = await relationship.ownedCreateResult("first-create");
    const daemonId = relationship.relationshipFile()?.relationship.daemonId;

    await relationship.disconnect();
    await relationship.beginConnect("fresh-token").result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("second-create", "second-execution");
    const second = await relationship.ownedCreateResult("second-create");

    expect(relationship.relationshipFile()?.relationship.daemonId).toBe(daemonId);
    expect(first).toMatchObject({ payload: { success: true, executionId: "first-execution" } });
    expect(second).toMatchObject({ payload: { success: true, executionId: "second-execution" } });
    expect(await relationship.durableOwnedAgentIds()).toHaveLength(2);
  });

  test("daemon shutdown fences a pending create before closing owned agents", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("shutdown-create", "execution-shutdown", { prompt: "sleep 30" });
    await relationship.agentCreationAttempts(1);

    const shutdown = relationship.shutdownDaemon();
    relationship.finishAgentCreation();
    await shutdown;

    expect(relationship.socketDeliveredResponse(0, "shutdown-create")).toBe(false);
    expect(await relationship.durableOwnedAgentIdsOnDisk()).toEqual([]);
  });
});
