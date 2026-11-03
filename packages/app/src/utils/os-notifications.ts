import { Asset } from "expo-asset";
import { getDesktopHost } from "@/desktop/host";
import { parseNotificationOpenTarget, WEB_NOTIFICATION_CLICK_EVENT } from "@/notification-open";
import { isNative } from "@/constants/platform";
import { getAppOsNotificationSends } from "@/notification-dismissal";

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

let permissionRequest: Promise<boolean> | null = null;
let notificationIconUrl: string | null | undefined;

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
  new (
    title: string,
    options?: {
      body?: string;
      data?: Record<string, unknown>;
      icon?: string;
      tag?: string;
      renotify?: boolean;
    },
  ): unknown;
} | null {
  const NotificationConstructor = (
    globalThis as {
      Notification?: {
        permission: string;
        requestPermission?: () => Promise<string>;
        new (
          title: string,
          options?: {
            body?: string;
            data?: Record<string, unknown>;
            icon?: string;
            tag?: string;
            renotify?: boolean;
          },
        ): unknown;
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
    return await getAppOsNotificationSends().sendDesktop(desktopNotificationSender, payload);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (NotificationConstructor) {
    const send = getAppOsNotificationSends().beginWeb(payload.data);
    const granted = await ensureNotificationPermission();
    // A tracked send can lose its slot or its thread while the prompt is open.
    const outcome = send
      ? send.afterPermission(granted)
      : ({ show: granted, result: false } as const);
    if (outcome.show) {
      const notification = new NotificationConstructor(payload.title, {
        body: payload.body,
        data: payload.data,
        icon: getWebNotificationIconUrl(),
        ...send?.options,
      }) as WebNotificationInstance;
      send?.shown(notification);
      if (hasNotificationClickTarget(payload.data)) {
        attachWebClickHandler(notification, payload.data);
      }
      return true;
    }
    return outcome.result;
  }

  return false;
}

/**
 * Tracks desktop notifications this renderer did not send, so those resolved meanwhile go
 * away. Call at startup.
 */
export async function adoptDeliveredOsNotifications(): Promise<void> {
  const getDelivered = getDesktopHost()?.notification?.getDeliveredNotifications;
  if (typeof getDelivered !== "function") return;
  getAppOsNotificationSends().adoptDelivered(await getDelivered().catch(() => []));
}
