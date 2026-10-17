import { PUSH_TEST_NOTIFICATION_KIND } from "@getpaseo/protocol/messages";
import type { NotificationBehavior } from "expo-notifications";

export function isPushTestNotification(data: Record<string, unknown> | undefined): boolean {
  return data?.kind === PUSH_TEST_NOTIFICATION_KIND;
}

const SILENT: NotificationBehavior = {
  shouldShowAlert: false,
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * While the app is open, notifications stay silent: the app already shows what they
 * report. A test notification shows anyway, since showing is what it tests.
 */
export function foregroundNotificationBehavior(
  data: Record<string, unknown> | undefined,
): NotificationBehavior {
  if (!isPushTestNotification(data)) return SILENT;
  return {
    ...SILENT,
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
  };
}

export type TestPushState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; outcome: string; error?: string };

/** The line under a host's row, or null when there is nothing to say. */
export function testPushMessage(input: {
  connected: boolean;
  supported: boolean;
  state: TestPushState;
}): { key: string; error?: string } | null {
  if (!input.connected) return null;
  if (!input.supported) return { key: "nativeNotifications.test.updateHost" };
  const { state } = input;
  if (state.kind === "idle") return null;
  if (state.kind === "sending") return { key: "nativeNotifications.test.sending" };
  if (state.outcome === "accepted") return { key: "nativeNotifications.test.accepted" };
  if (state.outcome === "no_token") return { key: "nativeNotifications.test.noToken" };
  return { key: "nativeNotifications.test.failed", error: state.error ?? state.outcome };
}
