import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { isPushTestNotification } from "@/push-notifications/test-push";
import { createCaughtUpTracker } from "./caught-up-tracker";
import { createAppCaughtUpEnvironment } from "./environment";
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
  const caughtUp = createCaughtUpTracker({
    environment: createAppCaughtUpEnvironment(),
    dismiss: (identifiers) => {
      void Promise.all(
        identifiers.map((identifier) =>
          Notifications.dismissNotificationAsync(identifier).catch(() => undefined),
        ),
      ).then(sync);
    },
  });
  presented = createPresentedNotificationSync({
    api: {
      list: async () =>
        (await Notifications.getPresentedNotificationsAsync()).map((notification) => ({
          identifier: notification.request.identifier,
          data: notification.request.content.data,
          title: notification.request.content.title,
          body: notification.request.content.body,
          deliveredAt: presentedAtMs(Platform.OS, notification.date),
        })),
      dismiss: (identifier) => Notifications.dismissNotificationAsync(identifier),
    },
    tracker: () => tracker,
    isTrackable: (data) => !isPushTestNotification(data as Record<string, unknown> | undefined),
    onUntracked: (pushes) => caughtUp.setPushes(pushes),
  });
  // Pushes Android posted while Paseo was closed predate the refresh this starts.
  const syncAndRefresh = () =>
    void presented?.sync().then(
      () => caughtUp.refreshAll(),
      () => undefined,
    );
  syncAndRefresh();
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") syncAndRefresh();
  });
  const received = Notifications.addNotificationReceivedListener(sync);
  return () => {
    appState.remove();
    received.remove();
    tracker.dispose();
    caughtUp.dispose();
  };
}
