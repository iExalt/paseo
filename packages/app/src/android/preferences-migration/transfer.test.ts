import { describe, expect, it } from "vitest";
import { migrateSidebarOrderState } from "@/stores/sidebar-order-store";
import { migrateSidebarViewState } from "@/stores/sidebar-view-store";
import { PersistedCollapsedProjectsSchema } from "@/stores/sidebar-collapsed-sections-store/state";
import { PanelPersistedStateSchema } from "@/stores/panel-store/state";
import { WorkspaceLayoutPersistedStateSchema } from "@/stores/workspace-layout-storage";
import {
  buildSelectedPreferencesImport,
  createPreferencesTransfer,
  matchingDaemonIds,
  parseTransferForPreview,
} from "./transfer";
import type { PreferenceStorage } from "./journal";

class MemoryStorage implements PreferenceStorage {
  values = new Map<string, string>();
  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  async removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("portable preferences projection", () => {
  it("exports only allowlisted values, strips provider feature payloads, and scopes daemon data by exact ID", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      "@paseo:app-settings",
      JSON.stringify({
        theme: "dark",
        uiFontFamily: "Inter",
        serviceUrl: "https://secret.example/token-value",
        password: "do-not-export",
      }),
    );
    storage.values.set(
      "@paseo:create-agent-preferences",
      JSON.stringify({
        provider: "provider-a",
        providerPreferences: {
          "provider-a": {
            model: "model-a",
            mode: "safe",
            featureValues: { apiToken: "secret-token" },
          },
        },
        workingDir: "/private/legacy-path",
        serverId: "daemon-not-transferred",
      }),
    );
    storage.values.set(
      "sidebar-view",
      JSON.stringify({
        state: {
          groupMode: "project",
          hostFilters: ["daemon-a", "daemon-unknown"],
          groupModeByServerId: { "daemon-a": "label", "daemon-unknown": "status" },
        },
        version: 1,
      }),
    );
    storage.values.set(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            "daemon-a:/Users/me/private-project": {
              focusedPaneId: "pane-a",
              root: {
                kind: "pane",
                pane: {
                  id: "pane-a",
                  tabIds: ["file-tab", "draft-tab"],
                  focusedTabId: "file-tab",
                  tabs: [
                    {
                      tabId: "file-tab",
                      createdAt: 1,
                      target: { kind: "file", path: "/Users/me/private-project/README.md" },
                      state: { secret: "not-exported" },
                    },
                    {
                      tabId: "draft-tab",
                      createdAt: 2,
                      target: { kind: "draft", draftId: "volatile-agent-id" },
                    },
                  ],
                },
              },
            },
          },
        },
        version: 1,
      }),
    );

    const contents = await createPreferencesTransfer({
      storage,
      configuredDaemonIds: ["daemon-a", "daemon-unknown"],
      sourceLabel: "Paseo on Android",
      now: new Date("2026-10-09T00:00:00.000Z"),
    });
    const parsed = parseTransferForPreview(contents);

    expect(contents).not.toContain("secret.example");
    expect(contents).not.toContain("do-not-export");
    expect(contents).not.toContain("secret-token");
    expect(contents).not.toContain("volatile-agent-id");
    expect(contents).not.toContain("not-exported");
    expect(parsed.createAgent.providerPreferences?.["provider-a"]).toEqual({
      model: "model-a",
      mode: "safe",
    });
    expect(parsed.sidebar?.hostFilters).toEqual(["daemon-a", "daemon-unknown"]);
    expect(Object.keys(parsed.workspaceLayouts ?? {})).toEqual([
      "daemon-a:/Users/me/private-project",
    ]);
    expect(matchingDaemonIds(parsed, ["daemon-a", "daemon-a-similar"])).toEqual(["daemon-a"]);
  });

  it("rejects unknown fields and oversized files before import", () => {
    expect(() =>
      parseTransferForPreview(JSON.stringify({ schemaVersion: 1, password: "secret" })),
    ).toThrow();
  });

  it("round-trips actual persisted schemas and replaces only the matching daemon's sidebar state", async () => {
    const storage = new MemoryStorage();
    const projectA = JSON.stringify(["daemon-a", "project-a"]);
    const projectB = JSON.stringify(["daemon-b", "project-b"]);
    storage.values.set(
      "sidebar-view",
      JSON.stringify({
        state: {
          groupMode: "project",
          hostFilters: ["daemon-a"],
          projectFilters: [projectA],
        },
      }),
    );
    storage.values.set(
      "sidebar-project-workspace-order",
      JSON.stringify({
        state: {
          projectOrder: [projectA],
          pinnedWorkspaceOrder: ["daemon-a:workspace-a"],
          workspaceOrderByProject: { [projectA]: ["daemon-a:workspace-a"] },
        },
      }),
    );
    storage.values.set(
      "sidebar-collapsed-sections",
      JSON.stringify({
        state: {
          collapsedProjectKeys: [projectA],
          collapsedWorkspaceGroupKeys: ["running"],
          collapsedPinned: true,
        },
      }),
    );
    storage.values.set(
      "panel-state",
      JSON.stringify({
        state: {
          desktop: {
            agentListOpen: true,
            focusModeEnabled: false,
            zoomed: true,
            focused: false,
            fileExplorerOpen: true,
          },
          explorerTab: "files",
        },
      }),
    );
    storage.values.set(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            "daemon-a:/Users/alice/project": {
              focusedPaneId: "pane-a",
              expandedPaths: ["/Users/alice/project/src"],
              root: {
                kind: "pane",
                pane: {
                  id: "pane-a",
                  tabIds: ["file-a"],
                  focusedTabId: "file-a",
                  tabs: [
                    {
                      tabId: "file-a",
                      createdAt: 1,
                      target: { kind: "file", path: "/Users/alice/project/README.md" },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    );

    const transfer = parseTransferForPreview(
      await createPreferencesTransfer({
        storage,
        configuredDaemonIds: ["daemon-a"],
        sourceLabel: "Bridge",
      }),
    );
    storage.values.set(
      "sidebar-view",
      JSON.stringify({
        state: {
          groupMode: "status",
          hostFilters: ["daemon-b"],
          projectFilters: [projectB],
        },
      }),
    );
    storage.values.set(
      "sidebar-project-workspace-order",
      JSON.stringify({
        state: {
          projectOrder: [projectB],
          pinnedWorkspaceOrder: ["daemon-b:workspace-b"],
          workspaceOrderByProject: { [projectB]: ["daemon-b:workspace-b"] },
        },
      }),
    );
    storage.values.set(
      "sidebar-collapsed-sections",
      JSON.stringify({
        state: {
          collapsedProjectKeys: [projectB],
          collapsedWorkspaceGroupKeys: ["done"],
          collapsedPinned: false,
        },
      }),
    );
    storage.values.set(
      "workspace-layout-state",
      JSON.stringify({ state: { layoutByWorkspace: {} } }),
    );
    storage.values.set(
      "panel-state",
      JSON.stringify({
        state: {
          desktop: { agentListOpen: false, focusModeEnabled: true },
          explorerTab: "changes",
        },
      }),
    );

    const writes = await buildSelectedPreferencesImport({
      storage,
      transfer,
      destinationDaemonIds: ["daemon-a"],
      selected: ["sidebar", "panel", "workspace"],
    });
    for (const { key, value } of writes) storage.values.set(key, value);

    const sidebar = JSON.parse(storage.values.get("sidebar-view") ?? "{}").state;
    expect(migrateSidebarViewState(sidebar).hostFilters).toEqual(["daemon-b", "daemon-a"]);
    expect(migrateSidebarViewState(sidebar).projectFilters).toEqual([projectB, projectA]);
    const order = JSON.parse(storage.values.get("sidebar-project-workspace-order") ?? "{}").state;
    expect(migrateSidebarOrderState(order).projectOrder).toEqual([projectB, projectA]);
    const collapsed = JSON.parse(storage.values.get("sidebar-collapsed-sections") ?? "{}").state;
    expect(PersistedCollapsedProjectsSchema.parse(collapsed)).toMatchObject({
      collapsedProjectKeys: [projectB, projectA],
      collapsedWorkspaceGroupKeys: ["running"],
      collapsedPinned: true,
    });
    const panel = JSON.parse(storage.values.get("panel-state") ?? "{}").state;
    expect(PanelPersistedStateSchema.parse(panel).desktop).toEqual({
      agentListOpen: true,
      focusModeEnabled: false,
      zoomed: true,
      focused: false,
      fileExplorerOpen: true,
    });
    const layout = JSON.parse(storage.values.get("workspace-layout-state") ?? "{}").state;
    const validatedLayout = WorkspaceLayoutPersistedStateSchema.parse(layout);
    expect(validatedLayout.layoutByWorkspace["daemon-a:/Users/alice/project"]).toHaveProperty(
      "root",
    );
    expect(validatedLayout.layoutByWorkspace["daemon-a:/Users/alice/project"]).not.toHaveProperty(
      "expandedPaths",
    );
    expect(writes.some(({ key }) => key.includes("daemon-registry"))).toBe(false);
  });
});
