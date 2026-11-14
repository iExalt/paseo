import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { lifecycleTaskEvent } from "./lifecycle-payload";

interface NativeLifecycle {
  prepareHost(serverId: string): Promise<string>;
  registerHost(serverId: string, registrationId: string | null): Promise<void>;
  apply(event: string): Promise<void>;
  recover(): Promise<void>;
  observed(serverId: string, registrationId: string): Promise<string[]>;
  reconcile(
    serverId: string,
    registrationId: string,
    observed: string[],
    active: string[],
  ): Promise<void>;
}
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeLifecycle>("PaseoNotificationLifecycle")
    : null;
// F-Droid excludes the native task module; do not evaluate its requireNativeModule call there.
const TaskManager = native
  ? (require("expo-task-manager") as typeof import("expo-task-manager"))
  : null;
const TASK = "paseo.android.notification-lifecycle.v1";

export function initializeBackgroundLifecycle(): void {
  if (native && TaskManager && !TaskManager.isTaskDefined(TASK)) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
      if (error) throw error;
      const event = lifecycleTaskEvent(data);
      if (!event) return;
      await native.apply(JSON.stringify(event));
      await native.recover();
    });
  }
}

export async function prepareLifecycle(
  client: DaemonClient,
  serverId: string,
): Promise<string | undefined> {
  if (
    !native ||
    !TaskManager ||
    client.getLastServerInfoMessage()?.features?.androidNotificationLifecycle !== true
  )
    return undefined;
  if (!(await TaskManager.isAvailableAsync())) return undefined;
  if (!(await TaskManager.isTaskRegisteredAsync(TASK))) await Notifications.registerTaskAsync(TASK);
  return native.prepareHost(serverId);
}

export async function removeLifecycleHost(serverId: string): Promise<void> {
  await native?.registerHost(serverId, null);
}

export function watchLifecycle(
  client: DaemonClient,
  serverId: string,
  registrationId: string,
): () => void {
  let stopped = false;
  let syncing = false;
  let again = false;
  const sync = async () => {
    if (
      stopped ||
      !native ||
      !client.isConnected ||
      client.getLastServerInfoMessage()?.features?.androidNotificationLifecycle !== true
    )
      return;
    if (syncing) {
      again = true;
      return;
    }
    syncing = true;
    try {
      do {
        again = false;
        const observed = await native.observed(serverId, registrationId);
        if (observed.length === 0) return;
        const active = await client.syncNotificationLifecycle();
        if (stopped) return;
        await native.reconcile(serverId, registrationId, observed, active);
        await native.recover();
      } while (again);
    } catch (error) {
      console.warn("[PushNotifications] Lifecycle catch-up deferred", error);
    } finally {
      syncing = false;
    }
  };
  const received = Notifications.addNotificationReceivedListener(() => {
    void sync();
  });
  const state = AppState.addEventListener("change", (value) => {
    if (value === "active") void sync();
  });
  const connected = client.subscribeConnectionStatus(() => {
    void sync();
  });
  // State-change events cover read/permission resolution while this app stays foregrounded.
  const signatures = new Map<string, string>();
  const events = client.subscribe((event) => {
    if (event.type === "agent_permission_resolved" || event.type === "agent_deleted") {
      void sync();
      return;
    }
    if (event.type !== "agent_update") return;
    const change = event.payload;
    const signature =
      change.kind === "upsert"
        ? JSON.stringify([
            change.agent.requiresAttention,
            change.agent.archivedAt,
            change.agent.pendingPermissions?.map((request) => request.id),
          ])
        : "removed";
    // Only the event stream, never our sync response, can request another catch-up.
    if (signatures.get(event.agentId) === signature) return;
    signatures.set(event.agentId, signature);
    void sync();
  });
  void sync();
  return () => {
    stopped = true;
    received.remove();
    state.remove();
    connected();
    events();
  };
}
