import { describe, expect, it } from "vitest";
import { resolveWorkspaceCommandCenterShortcuts } from "./workspace-shortcuts";

describe("resolveWorkspaceCommandCenterShortcuts", () => {
  it("assigns the New agent command its own shortcut", () => {
    expect(
      resolveWorkspaceCommandCenterShortcuts({
        overrides: {},
        platform: { isMac: true, usesDesktopBindings: true },
      }).newAgent,
    ).toEqual([["mod", "shift", "A"]]);
  });
  const paneBindings = [
    ["focusPaneLeft", "workspace-pane-focus-left-cmd-shift-left"],
    ["focusPaneRight", "workspace-pane-focus-right-cmd-shift-right"],
    ["focusPaneUp", "workspace-pane-focus-up-cmd-shift-up"],
    ["focusPaneDown", "workspace-pane-focus-down-cmd-shift-down"],
    ["moveTabLeft", "workspace-pane-move-tab-left-cmd-shift-alt-left"],
    ["moveTabRight", "workspace-pane-move-tab-right-cmd-shift-alt-right"],
    ["moveTabUp", "workspace-pane-move-tab-up-cmd-shift-alt-up"],
    ["moveTabDown", "workspace-pane-move-tab-down-cmd-shift-alt-down"],
  ] as const;

  it("keeps each pane command hint tied to its rebound binding", () => {
    const overrides = Object.fromEntries(
      paneBindings.map(([, id], index) => [id, `Cmd+Alt+${index + 1}`]),
    );
    const result = resolveWorkspaceCommandCenterShortcuts({
      overrides,
      platform: { isMac: true, usesDesktopBindings: true },
    });
    for (const [index, [field]] of paneBindings.entries()) {
      expect(result[field]).toEqual([["mod", "alt", String(index + 1)]]);
    }
  });
  it("removes pane command hints when their bindings are unassigned", () => {
    const overrides = Object.fromEntries(paneBindings.map(([, id]) => [id, null]));
    const result = resolveWorkspaceCommandCenterShortcuts({
      overrides,
      platform: { isMac: true, usesDesktopBindings: true },
    });
    for (const [field] of paneBindings) {
      expect(result[field]).toBeUndefined();
    }
  });
});
