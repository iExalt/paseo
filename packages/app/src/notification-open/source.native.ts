import * as Notifications from "expo-notifications";
import type { NotificationOpenSource, NotificationTap } from "./source";
import {
  foregroundNotificationBehavior,
  isPushTestNotification,
} from "@/push-notifications/test-push";
import { agentLog } from "@/utils/agent-log";

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
    handleNotification: async (notification) => {
      const data = notification.request.content.data as Record<string, unknown> | undefined;
      const behavior = foregroundNotificationBehavior(data);
      agentLog("push", "received", {
        id: notification.request.identifier,
        test: isPushTestNotification(data),
        shown: behavior.shouldShowBanner,
      });
      return behavior;
    },
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
