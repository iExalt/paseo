import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  claimWorkspaceNotificationMutation,
  useWorkspaceNotificationMutationPending,
} from "./pending";

export interface WorkspaceNotificationsMenuItemProps {
  serverId: string;
  workspaceId: string;
  testID: string;
}

export function WorkspaceNotificationsMenuItem({
  serverId,
  workspaceId,
  testID,
}: WorkspaceNotificationsMenuItemProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const supported = useHostFeature(serverId, "workspaceNotifications");
  const notifications = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.get(workspaceId)?.notifications ?? "on",
  );
  const pending = useWorkspaceNotificationMutationPending(serverId, workspaceId);
  const disabled = pending || !supported;

  const handleSelect = useCallback(() => {
    if (!supported) return;
    const release = claimWorkspaceNotificationMutation(serverId, workspaceId);
    if (!release) return;

    void (async () => {
      try {
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
        await client.setWorkspaceNotifications(workspaceId, notifications === "on" ? "off" : "on");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.toasts.hostDisconnected"),
        );
      } finally {
        release();
      }
    })();
  }, [notifications, serverId, supported, t, toast, workspaceId]);

  const label =
    notifications === "off"
      ? t("sidebar.workspace.actions.unmuteNotifications")
      : t("sidebar.workspace.actions.muteNotifications");
  const itemProps = {
    testID,
    disabled,
    selected: notifications === "off",
    status: pending ? ("pending" as const) : undefined,
    pendingLabel: t("sidebar.workspace.actions.updatingNotifications"),
    description: supported ? undefined : t("sidebar.workspace.actions.updateHostForNotifications"),
    onSelect: handleSelect,
  };

  // ContextMenuItem is the same shared menu-engine MenuItem re-export. The dropdown alias works
  // under either existing menu root and avoids introducing a second row implementation.
  return <DropdownMenuItem {...itemProps}>{label}</DropdownMenuItem>;
}
