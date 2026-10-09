import type { QueryClient } from "@tanstack/react-query";
import type { TransferSection } from "./transfer";

export async function reconcileImportedPreferences(
  queryClient: QueryClient,
  sections: readonly TransferSection[],
): Promise<void> {
  const selected = new Set(sections);
  const queryKeys: readonly unknown[][] = [
    ...(selected.has("appearance") ? [["app-settings"]] : []),
    ...(selected.has("defaults") ? [["form-preferences"]] : []),
    ...(selected.has("changes") ? [["changes-preferences"]] : []),
    ...(selected.has("editor") ? [["preferred-editor"]] : []),
    ...(selected.has("shortcuts") ? [["keyboard-shortcut-overrides"]] : []),
  ];
  for (const queryKey of queryKeys) {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    await queryClient.refetchQueries({ queryKey, type: "active" });
  }

  if (selected.has("sidebar")) {
    const [view, order, collapsed, routes] = await Promise.all([
      import("@/stores/sidebar-view-store"),
      import("@/stores/sidebar-order-store"),
      import("@/stores/sidebar-collapsed-sections-store"),
      import("@/workspace-service-routes/store"),
    ]);
    await Promise.all([
      view.useSidebarViewStore.persist.rehydrate(),
      order.useSidebarOrderStore.persist.rehydrate(),
      collapsed.useSidebarCollapsedSectionsStore.persist.rehydrate(),
      routes.useWorkspaceServiceRoutePreferencesStore.persist.rehydrate(),
    ]);
  }
  if (selected.has("panel")) {
    const panel = await import("@/stores/panel-store");
    await panel.usePanelStore.persist.rehydrate();
  }
  if (selected.has("workspace")) {
    const layout = await import("@/stores/workspace-layout-store");
    await layout.useWorkspaceLayoutStore.persist.rehydrate();
  }
}
