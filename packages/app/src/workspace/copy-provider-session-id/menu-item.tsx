import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceProviderSessionId } from "./resolve";

interface CopyProviderSessionIdMenuItemProps {
  serverId: string;
  workspaceId: string;
  /** The agent whose session wins when it belongs to this workspace, such as the focused tab. */
  preferredAgentId?: string | null;
  testID: string;
  /** The host menu's hoisted copy icon, so this row matches its sibling copy actions. */
  leading: ReactElement | null;
}

/**
 * Menu content only mounts while the menu is open, so this subscription scans the agent map only
 * then rather than on every store write for every sidebar row.
 */
export function CopyProviderSessionIdMenuItem({
  serverId,
  workspaceId,
  preferredAgentId,
  testID,
  leading,
}: CopyProviderSessionIdMenuItemProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const sessionId = useSessionStore((state) =>
    resolveWorkspaceProviderSessionId({
      agents: state.sessions[serverId]?.agents?.values(),
      workspaceId,
      preferredAgentId,
    }),
  );

  const handleSelect = useCallback(() => {
    if (!sessionId) return;
    void Clipboard.setStringAsync(sessionId).then(
      () => toast.copied(t("workspace.header.toasts.providerSessionIdCopiedLabel")),
      () => toast.error(t("workspace.tabs.toasts.copyFailed")),
    );
  }, [sessionId, t, toast]);

  if (!sessionId) {
    return null;
  }

  // ContextMenuItem is the same shared menu-engine MenuItem, so this row works under either root.
  return (
    <DropdownMenuItem testID={testID} leading={leading} onSelect={handleSelect}>
      {t("workspace.header.actions.copyProviderSessionId")}
    </DropdownMenuItem>
  );
}
