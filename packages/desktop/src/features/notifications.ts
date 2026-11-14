import path from "node:path";
import { existsSync } from "node:fs";
import { app, BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";

interface NotificationInput {
  title?: unknown;
  body?: unknown;
  data?: unknown;
  /** Thread key: a newer notification with the same id replaces the older one. */
  id?: unknown;
  /** Thread key plus reason, so a restarted app can tell what a delivered notification was. */
  groupId?: unknown;
}

export interface DeliveredNotification {
  id: string;
  groupId: string;
}

interface NotificationClickPayload {
  data?: Record<string, unknown>;
}

// Notifications are held until closed so their click handlers survive. A replaced macOS
// notification stays held for the session: macOS reports no event when it is replaced.
const activeNotifications = new Set<Notification>();
const notificationsById = new Map<string, Notification>();
/** The renderer's group id per thread, which carries the reason even where the OS drops it. */
const rendererGroupIds = new Map<string, string>();

function forgetNotification(notification: Notification, id: string | null): void {
  activeNotifications.delete(notification);
  if (id && notificationsById.get(id) === notification) {
    notificationsById.delete(id);
    rendererGroupIds.delete(id);
  }
}

/**
 * macOS keeps the renderer's group id, which carries the reason for the startup sweep.
 * Windows replaces a toast only when tag and group both match, so the group is the id.
 */
function resolveGroupId(id: string | null, groupId: string | null): string | null {
  if (!id) return null;
  if (process.platform === "darwin") return groupId;
  if (process.platform === "win32") return id;
  return null;
}

/** Removes delivered notifications by thread key. Unknown ids are ignored. */
export function dismissNotifications(ids: readonly string[]): void {
  const earlierLaunch: string[] = [];
  for (const id of ids) {
    const notification = notificationsById.get(id);
    notificationsById.delete(id);
    rendererGroupIds.delete(id);
    if (!notification) {
      earlierLaunch.push(id);
      continue;
    }
    activeNotifications.delete(notification);
    // close() also frees the native notification. Notification.remove() would leave it
    // registered under the id, where it can capture clicks meant for the thread's next one.
    notification.close();
  }
  // Only macOS can reach notifications delivered before this launch.
  if (process.platform === "darwin" && earlierLaunch.length > 0) {
    Notification.remove(earlierLaunch);
  }
}

/**
 * Notifications a fresh renderer should track: the ones this process still holds (after a
 * window reload), and on macOS those still in Notification Center from earlier launches.
 */
export async function listDeliveredNotifications(): Promise<DeliveredNotification[]> {
  const delivered = new Map<string, string>(rendererGroupIds);
  if (process.platform === "darwin") {
    for (const notification of await Notification.getHistory()) {
      if (notification.id && notification.groupId && !delivered.has(notification.id)) {
        delivered.set(notification.id, notification.groupId);
      }
    }
  }
  return [...delivered].map(([id, groupId]) => ({ id, groupId }));
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNotificationIcon(): Electron.NativeImage | null {
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "../assets/64x64.png"),
    path.resolve(__dirname, "../assets/128x128.png"),
  ];

  for (const iconPath of candidates) {
    if (!existsSync(iconPath)) {
      continue;
    }
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return null;
}

function focusSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win || win.isDestroyed()) {
    return null;
  }
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  return win;
}

/**
 * macOS requires a notification to have been shown at least once before
 * the app appears in System Preferences > Notifications. We fire a
 * silent no-op notification during startup to ensure registration.
 */
export function ensureNotificationCenterRegistration(): void {
  if (process.platform !== "darwin" || !Notification.isSupported()) {
    return;
  }

  const probe = new Notification({ title: app.name, silent: true });
  probe.on("show", () => probe.close());
  setTimeout(() => probe.close(), 2_000);
  probe.show();
}

export function registerNotificationHandlers(): void {
  ipcMain.handle("paseo:notification:isSupported", () => {
    return Notification.isSupported();
  });

  ipcMain.handle("paseo:notification:dismiss", (_event, rawIds?: unknown) => {
    const ids = Array.isArray(rawIds)
      ? rawIds.flatMap((value) => {
          const id = toTrimmedString(value);
          return id ? [id] : [];
        })
      : [];
    dismissNotifications(ids);
  });

  ipcMain.handle("paseo:notification:delivered", () => listDeliveredNotifications());

  ipcMain.handle("paseo:notification:send", async (event, rawInput?: NotificationInput) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const title = toTrimmedString(rawInput?.title);
    if (!title) {
      return false;
    }

    const body = toTrimmedString(rawInput?.body) ?? undefined;
    const data = toRecord(rawInput?.data);
    const id = toTrimmedString(rawInput?.id);
    const rendererGroupId = toTrimmedString(rawInput?.groupId);
    const groupId = resolveGroupId(id, rendererGroupId);
    const icon = getNotificationIcon();
    const settings = await getDesktopSettingsStore().get();
    const notification = new Notification({
      title,
      ...(body ? { body } : {}),
      ...(icon ? { icon } : {}),
      ...(id ? { id } : {}),
      ...(groupId ? { groupId } : {}),
      silent: !settings.notifications.playSound,
    });

    activeNotifications.add(notification);
    if (id) {
      const previous = notificationsById.get(id);
      notificationsById.set(id, notification);
      if (rendererGroupId) rendererGroupIds.set(id, rendererGroupId);
      else rendererGroupIds.delete(id);
      // macOS replaces a delivered notification with the same id, and closing the old object
      // would remove the new one by identifier. Linux ignores ids, so close the old one first.
      if (previous && process.platform !== "darwin") {
        activeNotifications.delete(previous);
        previous.close();
      }
    }

    notification.on("click", () => {
      const win = focusSenderWindow(event.sender);
      if (win && data && Object.keys(data).length > 0) {
        const payload: NotificationClickPayload = { data };
        win.webContents.send("paseo:event:notification-click", payload);
      }
      forgetNotification(notification, id);
    });

    notification.on("close", () => {
      forgetNotification(notification, id);
    });

    // macOS refuses a request (unsigned bundle, notifications turned off) only
    // through "failed", after show() has returned.
    const delivered = new Promise<boolean>((resolve) => {
      const fallback = setTimeout(() => resolve(true), 5_000);
      notification.once("show", () => {
        clearTimeout(fallback);
        resolve(true);
      });
      notification.once("failed", (_failure, error) => {
        clearTimeout(fallback);
        console.warn(`[notifications] Delivery failed: ${error}`);
        forgetNotification(notification, id);
        resolve(false);
      });
    });
    notification.show();
    return delivered;
  });
}
