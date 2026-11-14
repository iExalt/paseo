import { createNotificationDismissal, type NotificationDismissal } from "./dismissal";
import { getDesktopHost } from "@/desktop/host";
import { createAppNotificationDismissalEnvironment } from "./environment";
import { createOsNotificationSends, type OsNotificationSends } from "./os-sends";

export {
  agentNotificationGroupId,
  agentNotificationKey,
  parseDeliveredAgentNotification,
  readAgentNotificationData,
} from "./key";
export type { NotificationDismissal } from "./dismissal";
export type { OsNotificationSends } from "./os-sends";

/** Notification dismissal bound to the app's host runtime and session store. */
export function createAppNotificationDismissal(input: {
  dismissThreads: (keys: string[]) => void;
  dismissPushes?: (identifiers: string[]) => void;
}): NotificationDismissal {
  return createNotificationDismissal({
    environment: createAppNotificationDismissalEnvironment(),
    ...input,
  });
}

let appOsNotificationSends: OsNotificationSends | null = null;

/** The app's desktop and browser notification sends, tracked by the app's dismissal. */
export function getAppOsNotificationSends(): OsNotificationSends {
  appOsNotificationSends ??= createOsNotificationSends({
    createDismissal: (dismissThreads) => createAppNotificationDismissal({ dismissThreads }),
    dismissDesktop(keys) {
      const dismiss = getDesktopHost()?.notification?.dismissNotifications;
      if (typeof dismiss === "function") void dismiss(keys).catch(() => undefined);
    },
  });
  return appOsNotificationSends;
}
