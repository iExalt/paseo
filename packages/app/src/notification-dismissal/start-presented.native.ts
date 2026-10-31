import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { isPushTestNotification } from "@/push-notifications/test-push";
import { createAppNotificationDismissalTracker } from "./index";
import {
  createPresentedNotificationSync,
  presentedAtMs,
  type PresentedNotificationSync,
} from "./presented";

/**
 * Dismisses pushes in the notification shade once their threads are resolved. The phone
 * clears them while Paseo runs; ones resolved while it was closed go on the next open.
 */
export function startPresentedNotificationDismissal(): () => void {
  let presented: PresentedNotificationSync | null = null;
  const sync = () => void presented?.sync().catch(() => undefined);
  const tracker = createAppNotificationDismissalTracker((keys) => {
    // Pushes that arrived after the dismissed ones stay; the follow-up sync tracks them.
    void presented?.dismiss(keys).then(sync, sync);
  });
  presented = createPresentedNotificationSync({
    api: {
      list: async () =>
        (await Notifications.getPresentedNotificationsAsync()).map((notification) => ({
          identifier: notification.request.identifier,
          data: notification.request.content.data,
          deliveredAt: presentedAtMs(Platform.OS, notification.date),
        })),
      dismiss: (identifier) => Notifications.dismissNotificationAsync(identifier),
    },
    tracker: () => tracker,
    isTrackable: (data) => !isPushTestNotification(data as Record<string, unknown> | undefined),
  });
  sync();
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") sync();
  });
  const received = Notifications.addNotificationReceivedListener(sync);
  return () => {
    appState.remove();
    received.remove();
    tracker.dispose();
  };
}
