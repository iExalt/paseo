import { NotificationPreviewSchema } from "@getpaseo/protocol/notification-preview";
import { parseAndroidNotificationLifecycle } from "@getpaseo/protocol/android-notification-lifecycle";

/** Android's RemoteMessageSerializer places Expo's body JSON in data.dataString. */
export function lifecycleTaskEvent(payload: unknown, now = Date.now()) {
  if (!payload || typeof payload !== "object" || "actionIdentifier" in payload) return null;
  const data = "data" in payload ? payload.data : undefined;
  if (!data || typeof data !== "object") return null;
  let body: unknown = data;
  if ("dataString" in data && typeof data.dataString === "string") {
    try {
      body = JSON.parse(data.dataString) as unknown;
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object" || !("paseoLifecycle" in body)) return null;
  const event = parseAndroidNotificationLifecycle(body.paseoLifecycle, now);
  if (!event) return null;
  const preview = NotificationPreviewSchema.safeParse("preview" in body ? body.preview : undefined);
  return {
    ...event,
    ...(event.operation === "alert" && preview.success ? { tapPreview: preview.data } : {}),
  };
}
