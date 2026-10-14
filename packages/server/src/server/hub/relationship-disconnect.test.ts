import { afterEach, describe, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

describe("Hub relationship revocation and disconnect", () => {
  let relationship: HubRelationshipHarness | null = null;

  afterEach(async () => {
    await relationship?.close();
    relationship = null;
  });

  test("disconnect revokes an ambiguous pending enrollment before removing local authority", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");
    const enrollment = await relationship.enrollmentBegins();
    const credential = relationship.relationshipFile()?.credential?.secret;
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.failRevocations(1);

    const disconnected = await relationship.disconnect();
    const reconnected = await relationship.beginConnect("fresh-token").result;

    expect(disconnected).toMatchObject({
      state: "not_connected",
      hubOrigin: null,
      warning: expect.stringContaining("server-side revocation may remain pending"),
    });
    expect(reconnected.state).toBe("connecting");
    expect(relationship.revocationAttempts()).toBe(1);
    expect(relationship.latestRevocation()).toEqual(
      expect.objectContaining({
        daemonId: enrollment.daemonId,
        hubOrigin: enrollment.hubOrigin,
        credential,
      }),
    );
    expect(relationship.pendingRelationshipRetries()).toBe(0);
    expect(relationship.loggableValues(disconnected)).toContain(
      "Failed to notify Hub before removing local relationship",
    );
  });

  test("disconnect revokes only after an in-flight enrollment settles", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");
    const enrollment = await relationship.enrollmentBegins();

    const disconnecting = relationship.beginDisconnect();
    await relationship.connectionStateBecomes("disconnecting");
    expect(relationship.relationshipFile()?.state).toBe("disconnecting");
    expect(relationship.revocationAttempts()).toBe(0);

    relationship.completeEnrollment();
    await connecting.result;
    const disconnected = await disconnecting.result;

    expect(disconnected.state).toBe("not_connected");
    expect(relationship.latestRevocation()?.daemonId).toBe(enrollment.daemonId);
    expect(relationship.revocationAttempts()).toBe(1);
    expect(relationship.socketAttempts()).toBe(0);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("disconnect persists terminal intent only while remote notification is in flight", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.holdRevocation();

    const disconnecting = relationship.beginDisconnect();
    await relationship.relationshipStateBecomes("disconnecting");

    expect(await relationship.status()).toMatchObject({ state: "disconnecting" });
    expect(relationship.pendingRelationshipRetries()).toBe(0);

    relationship.completeRevocation();
    await expect(disconnecting.result).resolves.toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("force disconnect does not wait for or notify an in-flight enrollment", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");
    await relationship.enrollmentBegins();

    const disconnected = await relationship.disconnect(true);

    expect(disconnected).toMatchObject({ state: "not_connected", hubOrigin: null });
    expect(relationship.revocationAttempts()).toBe(0);
    expect(relationship.relationshipFile()).toBeNull();

    relationship.completeEnrollment();
    await connecting.result;
    expect(relationship.socketAttempts()).toBe(0);
    expect(await relationship.status()).toMatchObject({ state: "not_connected", hubOrigin: null });
  });

  test.each([
    [4403, "Hub revoked this relationship"],
    [401, "Hub rejected socket authentication (401)"],
    [403, "Hub rejected socket authentication (403)"],
  ] as const)("authentication rejection %s revokes permanently", async (code, reason) => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect("private-token").result;
    const enrollment = relationship.enrollmentAttempts()[0];
    const secret = relationship.relationshipFile()?.credential?.secret;
    relationship.rejectRelationship(code);

    await relationship.restartDaemon();
    const status = await relationship.status();
    const persisted = relationship.relationshipFile();

    expect(status).toMatchObject({
      state: "revoked",
      daemonId: enrollment.daemonId,
      hubOrigin: "https://hub.test",
      permissions: ["hub.execute"],
      lastError: reason,
    });
    expect(persisted?.state).toBe("revoked");
    expect(persisted?.relationship).toMatchObject({
      daemonId: enrollment.daemonId,
      hubOrigin: "https://hub.test",
      permissions: ["hub.execute"],
    });
    expect(persisted?.reason).toBe(reason);
    expect(persisted).not.toHaveProperty("credential");
    expect(persisted).not.toHaveProperty("relationship.idempotencyKey");
    expect(relationship.socketAttempts()).toBe(1);
    const loggable = relationship.loggableValues(status);
    const reconstructed = JSON.stringify({ status, persisted });
    expect(reconstructed).not.toContain(secret);
    expect(reconstructed).not.toContain(enrollment.credentialVerifier);
    expect(reconstructed).not.toContain(enrollment.token);
    expect(reconstructed).not.toContain(enrollment.idempotencyKey);
    expect(loggable).not.toContain(secret);
    expect(loggable).not.toContain(enrollment.credentialVerifier);
    expect(loggable).not.toContain(enrollment.token);
    expect(loggable).not.toContain(enrollment.idempotencyKey);
  });

  test("offline disconnect removes local authority after one notify attempt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.failRevocations(3);

    const disconnected = await relationship.disconnect();
    await relationship.restartDaemon();

    expect(disconnected).toMatchObject({
      state: "not_connected",
      hubOrigin: null,
      warning: expect.stringContaining("server-side revocation may remain pending"),
    });
    expect(await relationship.status()).toMatchObject({ state: "not_connected", hubOrigin: null });
    expect(relationship.revocationAttempts()).toBe(1);
    expect(relationship.socketAttempts()).toBe(1);
    expect(relationship.pendingRelationshipRetries()).toBe(0);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("successful disconnect notifies the Hub and returns clean local status", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;

    const disconnected = await relationship.disconnect();

    expect(disconnected).toMatchObject({
      state: "not_connected",
      hubOrigin: null,
      lastError: null,
    });
    expect(disconnected).not.toHaveProperty("warning");
    expect(relationship.revocationAttempts()).toBe(1);
    expect(await relationship.status()).toMatchObject({ state: "not_connected", lastError: null });
  });

  test("force disconnect removes local authority without notifying the Hub", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;

    const forced = await relationship.disconnect(true);

    expect(forced).toMatchObject({ state: "not_connected", hubOrigin: null });
    expect(forced).not.toHaveProperty("warning");
    expect(relationship.revocationAttempts()).toBe(0);
    expect(relationship.loggableValues(forced)).not.toContain(
      "Failed to notify Hub before removing local relationship",
    );
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("startup removes a legacy persisted disconnecting relationship", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    const active = relationship.relationshipFile();
    await relationship.corruptRelationshipFile(
      JSON.stringify({ ...active, state: "disconnecting" }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected", hubOrigin: null });
    expect(relationship.relationshipFile()).toBeNull();
    expect(relationship.revocationAttempts()).toBe(0);
    expect(relationship.pendingRelationshipRetries()).toBe(0);
    expect(relationship.loggableValues(await relationship.status())).toContain(
      "Removed legacy disconnecting Hub relationship during startup",
    );
  });

  test("disconnect leaves no intent artifacts and shutdown closes the owned agent", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("orphan-create", "execution-orphan", { prompt: "sleep 30" });
    const created = await relationship.ownedCreateResult("orphan-create");
    expect(created).toMatchObject({ payload: { agent: { status: "running" } } });

    await relationship.disconnect(true);
    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
    await relationship.restartDaemon();

    expect(await relationship.storedOwnedStatus(created.payload.agentId!)).toBe("closed");
  });
});
