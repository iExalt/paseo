import { Asset } from "expo-asset";
import { getDesktopHost } from "@/desktop/host";
import { parseNotificationOpenTarget, WEB_NOTIFICATION_CLICK_EVENT } from "@/notification-open";
import { isNative } from "@/constants/platform";
import {
  agentNotificationKey,
  createAppNotificationDismissalTracker,
  readAgentNotificationData,
  type NotificationDismissalTracker,
} from "@/notification-dismissal";

interface OsNotificationPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface WebNotificationClickDetail {
  data?: Record<string, unknown>;
}

interface WebNotificationInstance {
  addEventListener: (type: "click" | "close", listener: (event: Event) => void) => void;
  close: () => void;
}

interface WebNotificationOptions {
  body?: string;
  data?: Record<string, unknown>;
  icon?: string;
  tag?: string;
  /** Alert again when replacing a same-tag notification; Chrome replaces silently otherwise. */
  renotify?: boolean;
}

let permissionRequest: Promise<boolean> | null = null;
let notificationIconUrl: string | null | undefined;
let dismissalTracker: NotificationDismissalTracker | null = null;
/** Live browser notifications by thread key. Lost on reload; those stay until the user clears them. */
const liveWebNotifications = new Map<string, WebNotificationInstance>();
/** Keys tracked while their notification awaits permission, and whether dismissal came first. */
const pendingWebNotifications = new Map<string, { dismissed: boolean }>();

function getDismissalTracker(): NotificationDismissalTracker {
  dismissalTracker ??= createAppNotificationDismissalTracker((keys) => {
    for (const key of keys) {
      const pending = pendingWebNotifications.get(key);
      if (pending) pending.dismissed = true;
      liveWebNotifications.get(key)?.close();
      liveWebNotifications.delete(key);
    }
  });
  return dismissalTracker;
}

function getDesktopNotificationSender():
  | ((payload: {
      title: string;
      body?: string;
      data?: Record<string, unknown>;
    }) => Promise<boolean>)
  | null {
  const sendNotification = getDesktopHost()?.notification?.sendNotification;
  return typeof sendNotification === "function"
    ? (sendNotification as (payload: {
        title: string;
        body?: string;
        data?: Record<string, unknown>;
      }) => Promise<boolean>)
    : null;
}

function getWebNotificationConstructor(): {
  permission: string;
  requestPermission?: () => Promise<string>;
  new (title: string, options?: WebNotificationOptions): unknown;
} | null {
  const NotificationConstructor = (
    globalThis as {
      Notification?: {
        permission: string;
        requestPermission?: () => Promise<string>;
        new (title: string, options?: WebNotificationOptions): unknown;
      };
    }
  ).Notification;
  return NotificationConstructor ?? null;
}

async function ensureNotificationPermission(): Promise<boolean> {
  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) {
    return false;
  }
  if (NotificationConstructor.permission === "granted") {
    return true;
  }
  if (NotificationConstructor.permission === "denied") {
    return false;
  }
  if (permissionRequest) {
    return permissionRequest;
  }
  permissionRequest = Promise.resolve(
    NotificationConstructor.requestPermission
      ? NotificationConstructor.requestPermission()
      : "denied",
  ).then((permission) => permission === "granted");
  const result = await permissionRequest;
  permissionRequest = null;
  return result;
}

export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (isNative) {
    return false;
  }
  return await ensureNotificationPermission();
}

function hasNotificationClickTarget(data: Record<string, unknown> | undefined): boolean {
  return parseNotificationOpenTarget(data) !== null;
}

function getWebNotificationIconUrl(): string | undefined {
  if (notificationIconUrl !== undefined) {
    return notificationIconUrl ?? undefined;
  }

  try {
    const asset = Asset.fromModule(require("../../assets/images/notification-icon.png"));
    notificationIconUrl = asset.uri ?? null;
  } catch {
    notificationIconUrl = null;
  }

  return notificationIconUrl ?? undefined;
}

function dispatchWebNotificationClick(detail: WebNotificationClickDetail): boolean {
  const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  const CustomEventConstructor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;

  if (typeof dispatch !== "function" || !CustomEventConstructor) {
    return false;
  }

  const event = new CustomEventConstructor<WebNotificationClickDetail>(
    WEB_NOTIFICATION_CLICK_EVENT,
    {
      detail,
      cancelable: true,
    },
  );
  return !dispatch(event);
}

function attachWebClickHandler(
  notification: WebNotificationInstance,
  data: Record<string, unknown> | undefined,
): void {
  notification.addEventListener("click", () => {
    dispatchWebNotificationClick({ data });
  });
}

export async function sendOsNotification(payload: OsNotificationPayload): Promise<boolean> {
  // Mobile/native notifications should be remote push only.
  if (isNative) {
    return false;
  }

  const desktopNotificationSender = getDesktopNotificationSender();
  if (desktopNotificationSender) {
    return await desktopNotificationSender(payload);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) return false;
  const agent = readAgentNotificationData(payload.data);
  const key = agent ? agentNotificationKey(agent) : null;
  const pending = { dismissed: false };
  if (agent && key) {
    pendingWebNotifications.set(key, pending);
    // Track before awaiting permission so state that changes meanwhile is still observed.
    getDismissalTracker().track(agent, agent.reason);
  }
  const granted = await ensureNotificationPermission();
  if (key) {
    // A newer notification for the thread, sent during the wait, owns the slot and its entry.
    if (pendingWebNotifications.get(key) !== pending) return false;
    pendingWebNotifications.delete(key);
  }
  if (!granted) {
    if (key) getDismissalTracker().forget(key);
    return false;
  }
  // Resolved while permission was pending: the notification is already out of date.
  if (pending.dismissed) return true;
  const notification = new NotificationConstructor(payload.title, {
    body: payload.body,
    data: payload.data,
    icon: getWebNotificationIconUrl(),
    ...(key ? { tag: key, renotify: true } : {}),
  }) as WebNotificationInstance;
  if (key) {
    // A same-tag notification replaced the previous one; closing the old instance is not needed.
    liveWebNotifications.set(key, notification);
    notification.addEventListener("close", () => {
      // The user cleared it; stop holding the host's directory for it. A newer notification
      // for the thread, live or still pending, keeps the entry.
      if (liveWebNotifications.get(key) !== notification || pendingWebNotifications.has(key)) {
        return;
      }
      liveWebNotifications.delete(key);
      getDismissalTracker().forget(key);
    });
  }
  if (hasNotificationClickTarget(payload.data)) {
    attachWebClickHandler(notification, payload.data);
  }
  return true;
}
