import { Asset } from "expo-asset";
import { getDesktopHost, type DesktopNotificationBridge } from "@/desktop/host";
import { parseNotificationOpenTarget, WEB_NOTIFICATION_CLICK_EVENT } from "@/notification-open";
import { isNative } from "@/constants/platform";
import {
  agentNotificationGroupId,
  agentNotificationKey,
  createAppNotificationDismissalTracker,
  parseDeliveredAgentNotification,
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
/** Keys tracked while their notification is still being shown, and whether dismissal came first. */
const pendingNotifications = new Map<string, { dismissed: boolean }>();

type DesktopNotificationSender = Required<Pick<DesktopNotificationBridge, "sendNotification">> &
  DesktopNotificationBridge;

function getDesktopNotificationBridge(): DesktopNotificationSender | null {
  const bridge = getDesktopHost()?.notification;
  return typeof bridge?.sendNotification === "function"
    ? (bridge as DesktopNotificationSender)
    : null;
}

function dismissDesktopNotifications(keys: string[]): void {
  const dismiss = getDesktopNotificationBridge()?.dismissNotifications;
  if (typeof dismiss === "function") void dismiss(keys).catch(() => undefined);
}

function getDismissalTracker(): NotificationDismissalTracker {
  dismissalTracker ??= createAppNotificationDismissalTracker((keys) => {
    for (const key of keys) {
      const pending = pendingNotifications.get(key);
      if (pending) pending.dismissed = true;
      liveWebNotifications.get(key)?.close();
      liveWebNotifications.delete(key);
    }
    dismissDesktopNotifications(keys);
  });
  return dismissalTracker;
}

/**
 * Tracks notifications still in the desktop notification center from an earlier launch, so
 * the ones whose threads were resolved meanwhile go away. Call once at startup.
 */
export async function adoptDeliveredOsNotifications(): Promise<void> {
  const getDelivered = getDesktopNotificationBridge()?.getDeliveredNotifications;
  if (typeof getDelivered !== "function") return;
  const delivered = await getDelivered().catch(() => []);
  for (const notification of delivered) {
    const agent = parseDeliveredAgentNotification(notification);
    if (agent) getDismissalTracker().track(agent, agent.reason, { createdAt: 0, ifAbsent: true });
  }
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

interface TrackedSend {
  key: string;
  groupId: string;
  pending: { dismissed: boolean };
}

/** Tracks an agent notification before it is shown, so state changes meanwhile are seen. */
function beginTrackedSend(data: Record<string, unknown> | undefined): TrackedSend | null {
  const agent = readAgentNotificationData(data);
  if (!agent) return null;
  const key = agentNotificationKey(agent);
  const pending = { dismissed: false };
  // Registered first: tracking can dismiss synchronously.
  pendingNotifications.set(key, pending);
  getDismissalTracker().track(agent, agent.reason);
  return { key, groupId: agentNotificationGroupId(key, agent.reason), pending };
}

/** Ends the pending phase; false when a newer send for the thread took over its slot. */
function finishTrackedSend(send: TrackedSend): boolean {
  if (pendingNotifications.get(send.key) !== send.pending) return false;
  pendingNotifications.delete(send.key);
  return true;
}

async function sendDesktopNotification(
  bridge: DesktopNotificationSender,
  payload: OsNotificationPayload,
): Promise<boolean> {
  const send = beginTrackedSend(payload.data);
  const shown = await bridge.sendNotification(
    send ? { ...payload, id: send.key, groupId: send.groupId } : payload,
  );
  // A newer send for the thread replaces this notification and owns its entry.
  if (!send || !finishTrackedSend(send)) return shown;
  if (!shown) getDismissalTracker().forget(send.key);
  // Resolved while the main process was showing it; there was nothing to remove yet.
  else if (send.pending.dismissed) dismissDesktopNotifications([send.key]);
  return shown;
}

export async function sendOsNotification(payload: OsNotificationPayload): Promise<boolean> {
  // Mobile/native notifications should be remote push only.
  if (isNative) {
    return false;
  }

  const desktopBridge = getDesktopNotificationBridge();
  if (desktopBridge) {
    return await sendDesktopNotification(desktopBridge, payload);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) return false;
  const send = beginTrackedSend(payload.data);
  const granted = await ensureNotificationPermission();
  // A newer notification for the thread, sent during the wait, owns the slot and its entry.
  if (send && !finishTrackedSend(send)) return false;
  if (!granted) {
    if (send) getDismissalTracker().forget(send.key);
    return false;
  }
  // Resolved while permission was pending: the notification is already out of date.
  if (send?.pending.dismissed) return true;
  const notification = new NotificationConstructor(payload.title, {
    body: payload.body,
    data: payload.data,
    icon: getWebNotificationIconUrl(),
    ...(send ? { tag: send.key, renotify: true } : {}),
  }) as WebNotificationInstance;
  if (send) {
    const { key } = send;
    // A same-tag notification replaced the previous one; closing the old instance is not needed.
    liveWebNotifications.set(key, notification);
    notification.addEventListener("close", () => {
      // The user cleared it; stop holding the host's directory for it. A newer notification
      // for the thread, live or still pending, keeps the entry.
      if (liveWebNotifications.get(key) !== notification || pendingNotifications.has(key)) {
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
