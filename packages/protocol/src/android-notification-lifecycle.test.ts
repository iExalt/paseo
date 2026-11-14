import { describe, expect, it } from "vitest";
import {
  ANDROID_NOTIFICATION_LIFETIME_MS,
  parseAndroidNotificationLifecycle,
} from "./android-notification-lifecycle.js";

const now = 1_000_000;
const alert = {
  v: 1,
  operation: "alert",
  serverId: "host",
  agentId: "agent",
  registrationId: "11111111-1111-4111-8111-111111111111",
  episodeId: "22222222-2222-4222-8222-222222222222",
  lane: "question",
  reason: "permission",
  issuedAt: now,
  expiresAt: now + ANDROID_NOTIFICATION_LIFETIME_MS,
  preview: { title: "Question", body: "Allow?" },
};

describe("Android notification lifecycle contract", () => {
  it("accepts nested preview without exposing Expo auto-presentation fields", () => {
    const data = { paseoLifecycle: parseAndroidNotificationLifecycle(alert, now) };
    expect(data.paseoLifecycle).toEqual(alert);
    expect(data).not.toHaveProperty("title");
    expect(data).not.toHaveProperty("message");
  });

  it("rejects mismatched lanes, unsupported error alerts and malformed identities", () => {
    expect(parseAndroidNotificationLifecycle({ ...alert, lane: "attention" }, now)).toBeNull();
    expect(parseAndroidNotificationLifecycle({ ...alert, reason: "error" }, now)).toBeNull();
    expect(parseAndroidNotificationLifecycle({ ...alert, episodeId: "" }, now)).toBeNull();
    expect(
      parseAndroidNotificationLifecycle(
        { ...alert, preview: { title: "x".repeat(221), body: "" } },
        now,
      ),
    ).toBeNull();
  });

  it("bounds alert lifetime and rejects delayed/expired alerts", () => {
    expect(parseAndroidNotificationLifecycle(alert, alert.expiresAt)).toBeNull();
    expect(
      parseAndroidNotificationLifecycle({ ...alert, expiresAt: alert.expiresAt + 1 }, now),
    ).toBeNull();
    expect(parseAndroidNotificationLifecycle({ ...alert, expiresAt: now }, now)).toBeNull();
    expect(parseAndroidNotificationLifecycle(alert, 0)).toBeNull();
  });

  it("accepts an expired resolution to remove an existing row without allowing an alert", () => {
    const resolve = { ...alert, operation: "resolve" };
    const parsed = parseAndroidNotificationLifecycle(resolve, alert.expiresAt + 1);
    expect(parsed?.operation).toBe("resolve");
    expect(parsed).not.toHaveProperty("preview");
    expect(parseAndroidNotificationLifecycle(alert, alert.expiresAt + 1)).toBeNull();
  });
});
