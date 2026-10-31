import { createAppNotificationDismissalEnvironment } from "./environment";
import { createNotificationDismissalTracker, type NotificationDismissalTracker } from "./tracker";

export {
  agentNotificationGroupId,
  agentNotificationKey,
  parseDeliveredAgentNotification,
  readAgentNotificationData,
} from "./key";
export type { NotificationDismissalTracker } from "./tracker";

/** A tracker bound to the app's host runtime and session store. */
export function createAppNotificationDismissalTracker(
  dismiss: (keys: string[]) => void,
): NotificationDismissalTracker {
  return createNotificationDismissalTracker({
    environment: createAppNotificationDismissalEnvironment(),
    dismiss,
  });
}
