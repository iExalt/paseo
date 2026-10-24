import * as Notifications from "expo-notifications";
import type { NotificationOpenSource, NotificationTap } from "./source";
import {
  foregroundNotificationBehavior,
  isPushTestNotification,
} from "@/push-notifications/test-push";

function toTap(response: Notifications.NotificationResponse): NotificationTap {
  return {
    id: response.notification.request.identifier,
    data: response.notification.request.content.data,
  };
}

function isTestPush(response: Notifications.NotificationResponse): boolean {
  return isPushTestNotification(
    response.notification.request.content.data as Record<string, unknown> | undefined,
  );
}

export function createNotificationOpenSource(): NotificationOpenSource {
  Notifications.setNotificationHandler({
    // Foreground notifications stay silent except a test notification, which must show.
    handleNotification: async (notification) =>
      foregroundNotificationBehavior(
        notification.request.content.data as Record<string, unknown> | undefined,
      ),
  });
  return {
    subscribe(onTap) {
      const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        // A test notification has nothing to open.
        if (!isTestPush(response)) onTap(toTap(response));
      });
      return () => subscription.remove();
    },
    async takeLaunchTap() {
      const response = await Notifications.getLastNotificationResponseAsync();
      return response && !isTestPush(response) ? toTap(response) : null;
    },
    acknowledge() {
      Notifications.clearLastNotificationResponse();
    },
  };
}
