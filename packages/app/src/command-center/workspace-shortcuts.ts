import {
  resolveShortcutKeysForAction,
  type ShortcutOverrides,
} from "@/keyboard/keyboard-shortcuts";
import type { WorkspaceCommandCenterShortcuts } from "./workspace-contributions";

interface ResolveWorkspaceCommandCenterShortcutsInput {
  overrides: ShortcutOverrides;
  platform: { isMac: boolean; usesDesktopBindings: boolean };
}

export function resolveWorkspaceCommandCenterShortcuts({
  overrides,
  platform,
}: ResolveWorkspaceCommandCenterShortcutsInput): WorkspaceCommandCenterShortcuts {
  const keysFor = (actionId: string) =>
    resolveShortcutKeysForAction(actionId, overrides, platform) ?? undefined;
  return {
    newAgent: keysFor("workspace-tab-target-agent"),
    newTerminal: keysFor("workspace-terminal-new"),
    splitRight: keysFor("workspace-pane-split-right"),
    splitDown: keysFor("workspace-pane-split-down"),
    archiveWorkspace: keysFor("archive-workspace"),
    previousTab: keysFor("workspace-tab-prev"),
    nextTab: keysFor("workspace-tab-next"),
    closeCurrentTab: keysFor("workspace-tab-close-current"),
    closePane: keysFor("workspace-pane-close"),
    toggleFocusMode: keysFor("toggle-focus"),
    toggleExplorerSidebar: keysFor("toggle-right-sidebar"),
    focusPaneLeft: keysFor("workspace-pane-focus-left"),
    focusPaneRight: keysFor("workspace-pane-focus-right"),
    focusPaneUp: keysFor("workspace-pane-focus-up"),
    focusPaneDown: keysFor("workspace-pane-focus-down"),
    moveTabLeft: keysFor("workspace-pane-move-tab-left"),
    moveTabRight: keysFor("workspace-pane-move-tab-right"),
    moveTabUp: keysFor("workspace-pane-move-tab-up"),
    moveTabDown: keysFor("workspace-pane-move-tab-down"),
    // Workspace management shortcuts
    pinWorkspace: keysFor("pin-workspace"),
  };
}
