import { describe, expect, test } from "vitest";
import { foregroundNotificationBehavior, testPushMessage } from "./test-push";

describe("test notifications", () => {
  test("only a test notification shows while the app is open", () => {
    expect(foregroundNotificationBehavior({ kind: "push_test" })).toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
    });
    for (const data of [undefined, { serverId: "host", agentId: "agent" }, { kind: "other" }]) {
      expect(foregroundNotificationBehavior(data)).toMatchObject({
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
      });
    }
  });

  test("each outcome has its own message, and an old host asks for an update", () => {
    const connected = { connected: true, supported: true };
    expect(testPushMessage({ ...connected, state: { kind: "idle" } })).toBeNull();
    expect(testPushMessage({ ...connected, state: { kind: "sending" } })?.key).toBe(
      "nativeNotifications.test.sending",
    );
    expect(
      testPushMessage({ ...connected, state: { kind: "done", outcome: "accepted" } })?.key,
    ).toBe("nativeNotifications.test.accepted");
    expect(
      testPushMessage({ ...connected, state: { kind: "done", outcome: "no_token" } })?.key,
    ).toBe("nativeNotifications.test.noToken");
    expect(
      testPushMessage({
        ...connected,
        state: { kind: "done", outcome: "failed", error: "InvalidCredentials" },
      }),
    ).toEqual({ key: "nativeNotifications.test.failed", error: "InvalidCredentials" });
    // An outcome a newer host adds still reads as a failure with its name.
    expect(
      testPushMessage({ ...connected, state: { kind: "done", outcome: "unavailable" } }),
    ).toEqual({ key: "nativeNotifications.test.failed", error: "unavailable" });
    expect(
      testPushMessage({ connected: true, supported: false, state: { kind: "idle" } })?.key,
    ).toBe("nativeNotifications.test.updateHost");
    expect(
      testPushMessage({ connected: false, supported: false, state: { kind: "idle" } }),
    ).toBeNull();
  });
});
