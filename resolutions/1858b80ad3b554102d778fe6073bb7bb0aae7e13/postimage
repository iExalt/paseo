import { createHash } from "node:crypto";
import { platform } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { getHostName } from "../host-name.js";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

async function captureUnhandledRejections(action: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const capture = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", capture);
  try {
    await action();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", capture);
  }
  return rejections;
}

describe("Hub relationship enrollment and persistence", () => {
  let relationship: HubRelationshipHarness | null = null;

  afterEach(async () => {
    await relationship?.close();
    relationship = null;
  });

  test("Hub URLs cannot persist embedded credentials", async () => {
    relationship = await HubRelationshipHarness.start();

    await expect(
      relationship.beginConnect("ceremony-token", "https://user:password@hub.example").result,
    ).rejects.toThrow();

    expect(relationship.relationshipFile()).toBeNull();
    expect(relationship.enrollmentAttempts()).toEqual([]);
  });

  test("an authenticated external socket can manage the Hub relationship", async () => {
    relationship = await HubRelationshipHarness.start();

    const responses = await relationship.manageRelationshipFromExternalSocket();

    expect(responses.map((response) => response.type)).toEqual([
      "hub.management.daemon.connect.response",
      "hub.management.daemon.get_status.response",
      "hub.management.daemon.disconnect.response",
    ]);
    expect(relationship.enrollmentAttempts()).toHaveLength(1);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("an authenticated browser socket can manage the Hub relationship", async () => {
    relationship = await HubRelationshipHarness.start();

    const response = await relationship.connectFromBrowserSocket();

    expect(response.type).toBe("hub.management.daemon.connect.response");
    expect(relationship.enrollmentAttempts()).toHaveLength(1);
    expect(relationship.relationshipFile()?.state).toBe("active");
  });

  test("persists private generated authority before enrollment and active before dialing", async () => {
    relationship = await HubRelationshipHarness.start();
    const privateFileMode = platform() === "win32" ? 0o666 : 0o600;
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");

    const enrollment = await relationship.enrollmentBegins();
    const pending = relationship.enrollmentInvocation();

    expect(pending).toMatchObject({
      record: {
        state: "pending",
        relationship: {
          daemonId: enrollment.daemonId,
          idempotencyKey: enrollment.idempotencyKey,
        },
        credential: { secret: expect.any(String) },
        enrollment: { token: "one-time-token" },
        identity: { serverId: expect.any(String), daemonPublicKey: expect.any(String) },
      },
    });
    expect(pending.mode).toBe(privateFileMode);
    const secret = pending.record.credential?.secret;
    expect(secret).toEqual(expect.any(String));
    expect(enrollment.credentialVerifier).toBe(
      createHash("sha256")
        .update(secret ?? "")
        .digest("base64url"),
    );
    expect(enrollment.hostname).toBe(getHostName());
    relationship.completeEnrollment();
    await connecting.result;
    await relationship.socketDialed();
    expect(relationship.socketInvocation()).toMatchObject({
      mode: privateFileMode,
      record: { state: "active", relationship: { daemonId: enrollment.daemonId } },
    });
  });

  test("new relationships can connect without granting Hub execution", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.returnEnrollmentPermissions([]);

    await relationship.beginConnect("registered-token", "https://hub.example", false).result;
    relationship.connectLatestSocket();
    const responses = relationship.sendHubRequestOnLatest({
      type: "hub.execution.agent.create.request",
      requestId: "registered-execution",
      executionId: "execution-1",
      provider: "codex",
      cwd: "/workspace",
      prompt: "Do not run",
    });

    expect(relationship.relationshipFile()?.relationship.permissions).toEqual([]);
    expect(responses).toContainEqual({
      type: "rpc_error",
      payload: {
        requestId: "registered-execution",
        requestType: "hub.execution.agent.create.request",
        error: "Session is not authorized for hub.execution.agent.create.request",
        code: "access_denied",
      },
    });

    await relationship.grantPermission("hub.execute");
    expect(relationship.relationshipFile()?.relationship.permissions).toEqual(["hub.execute"]);
    relationship.beginOwnedCreate("granted-execution", "execution-after-grant");
    await expect(relationship.ownedCreateResult("granted-execution")).resolves.toMatchObject({
      payload: { success: true, executionId: "execution-after-grant" },
    });

    await relationship.revokePermission("hub.execute");
    expect(relationship.relationshipFile()?.relationship.permissions).toEqual([]);
    const revokedResponses = relationship.sendHubRequestOnLatest({
      type: "hub.execution.agent.create.request",
      requestId: "revoked-execution",
      executionId: "execution-after-revoke",
      provider: "codex",
      cwd: "/workspace",
      prompt: "Do not run",
    });
    expect(revokedResponses).toContainEqual({
      type: "rpc_error",
      payload: {
        requestId: "revoked-execution",
        requestType: "hub.execution.agent.create.request",
        error: "Session is not authorized for hub.execution.agent.create.request",
        code: "access_denied",
      },
    });
  });

  test("Hub enrollment cannot widen the daemon's locally granted permissions", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.returnEnrollmentPermissions(["hub.execute", "daemon.manage"]);

    await relationship.beginConnect().result;
    expect(relationship.relationshipFile()?.relationship.permissions).toEqual(["hub.execute"]);
    expect((await relationship.status()).state).toBe("reconnecting");
    expect(relationship.socketAttempts()).toBe(0);
  });

  test("a lost enrollment response reuses the exact ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("same-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;

    await relationship.retry();
    const attempts = relationship.enrollmentAttempts();

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(relationship.enrolledRelationships()).toBe(1);
  });

  test("a fresh token replaces the token for a pending enrollment ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const firstConnect = relationship.beginConnect("expired-token");
    const firstResult = expect(firstConnect.result).resolves.toMatchObject({
      state: "reconnecting",
    });
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await firstResult;

    relationship.holdEnrollment();
    const secondConnect = relationship.beginConnect("fresh-token");
    const secondResult = expect(secondConnect.result).resolves.toMatchObject({
      state: "connecting",
    });
    const retried = await relationship.enrollmentBegins();

    expect(retried.token).toBe("fresh-token");
    expect(relationship.relationshipFile()?.enrollment?.token).toBe("fresh-token");
    relationship.completeEnrollment();
    await secondResult;
  });

  test("a stale enrollment rejection cannot discard a fresh pending ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const expiredConnect = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();

    relationship.holdEnrollment();
    const freshConnect = relationship.beginConnect("fresh-token");
    const freshEnrollment = await relationship.enrollmentBegins();
    relationship.rejectEnrollment(0, 403);
    await expiredConnect.result;

    expect(relationship.relationshipFile()?.enrollment?.token).toBe("fresh-token");
    expect(relationship.pendingRelationshipRetries()).toBe(0);

    relationship.completeEnrollment();
    await freshConnect.result;

    expect(freshEnrollment.token).toBe("fresh-token");
    expect(relationship.relationshipFile()?.state).toBe("active");
    expect(relationship.enrollmentAttempts()).toHaveLength(2);
    expect(relationship.pendingRelationshipRetries()).toBe(0);
  });

  test("a rejected pending enrollment is discarded without blocking daemon restart", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.rejectNextEnrollment(401);

    await relationship.restartDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("a scheduled enrollment rejection is contained after removing pending authority", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.rejectNextEnrollment(403);

    const unhandledRejections = await captureUnhandledRejections(() => relationship!.retry());
    const status = await relationship.status();

    expect(status).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(relationship.pendingRelationshipRetries()).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });

  test.each(["{not-json", JSON.stringify({ version: 1, state: "unknown" })])(
    "an invalid relationship file is quarantined without blocking daemon startup",
    async (contents) => {
      relationship = await HubRelationshipHarness.start();
      await relationship.corruptRelationshipFile(contents);

      await relationship.startStoppedDaemon();

      expect(await relationship.status()).toMatchObject({ state: "not_connected" });
      expect(relationship.relationshipFile()).toBeNull();
      expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    },
  );

  test("legacy execution scope migrates once to the semantic permission", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "active",
        relationship: {
          daemonId: "daemon-legacy",
          idempotencyKey: "ceremony-legacy",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        transport: { kind: "direct_websocket", webSocketUrl: "wss://hub.test/daemon" },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(relationship.relationshipFile()).toMatchObject({
      version: 2,
      relationship: { permissions: ["hub.execute"] },
    });
    expect(await relationship.status()).toMatchObject({ permissions: ["hub.execute"] });
  });

  test.each([
    ["a non-HTTP scheme", "ftp://hub.test"],
    ["embedded credentials", "https://user:password@hub.test"],
    ["a query", "https://hub.test?token=secret"],
    ["a fragment", "https://hub.test#secret"],
  ])("a persisted Hub origin with %s is quarantined before startup", async (_, hubOrigin) => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "pending",
        relationship: {
          daemonId: "daemon-1",
          idempotencyKey: "ceremony-1",
          hubOrigin,
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        enrollment: { token: "enrollment-token" },
        identity: { serverId: "server-1", daemonPublicKey: "public-key" },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.enrollmentAttempts()).toEqual([]);
  });

  test("a persisted Hub relationship cannot widen its local permissions", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    const persisted = relationship.relationshipFile();
    expect(persisted).not.toBeNull();
    persisted!.relationship.permissions = ["*"];
    await relationship.corruptRelationshipFile(JSON.stringify(persisted));
    const socketAttemptsBeforeRestart = relationship.socketAttempts();

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.socketAttempts()).toBe(socketAttemptsBeforeRestart);
  });

  test("a persisted non-WebSocket transport is quarantined before daemon startup", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "active",
        relationship: {
          id: "relationship-1",
          idempotencyKey: "ceremony-1",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        transport: { kind: "direct_websocket", webSocketUrl: "ftp://hub.test/daemon" },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.socketAttempts()).toBe(0);
  });

  test("a persisted WebSocket transport with a fragment is quarantined before startup", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "active",
        relationship: {
          id: "relationship-1",
          idempotencyKey: "ceremony-1",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        transport: {
          kind: "direct_websocket",
          webSocketUrl: "wss://hub.test/daemon#fragment",
        },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.socketAttempts()).toBe(0);
  });
});
