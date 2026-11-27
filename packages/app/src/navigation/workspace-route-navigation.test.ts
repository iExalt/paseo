import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationContainerRefWithCurrent } from "expo-router/react-navigation";
import {
  getFocusedWorkspaceSelection,
  navigateToHostWorkspaceRoute,
  registerWorkspaceRouteNavigationRef,
} from "./workspace-route-navigation";

function createNavigationRef(
  options: { ready?: boolean; currentRoute?: { name: string; params?: object } } = {},
) {
  let ready = options.ready ?? true;
  const readyListeners = new Set<() => void>();
  const navigation = {
    isReady: () => ready,
    getCurrentRoute: () => options.currentRoute,
    addListener: (event: string, listener: () => void) => {
      if (event === "state") readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  };
  const navigationRef = {
    ...navigation,
    current: navigation,
  } as unknown as NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>;

  return {
    navigationRef,
    becomeReady() {
      ready = true;
      for (const listener of readyListeners) listener();
    },
  };
}

describe("navigateToHostWorkspaceRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWorkspaceRouteNavigationRef(createNavigationRef().navigationRef)();
  });

  it("preserves the full workspace href and its open intent", () => {
    const { navigationRef } = createNavigationRef();
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();
    const href = "/h/server-1/workspace/workspace-a?open=agent%3Aagent-1";

    navigateToHostWorkspaceRoute(href, { dismissTo });

    expect(dismissTo).toHaveBeenCalledExactlyOnceWith(href);
  });

  it("waits for the root navigator before applying a route intent", () => {
    const { navigationRef, becomeReady } = createNavigationRef({ ready: false });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });
    expect(dismissTo).not.toHaveBeenCalled();

    becomeReady();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
    becomeReady();
    expect(dismissTo).toHaveBeenCalledTimes(1);
  });

  it("retains an intent submitted before the root ref registers", () => {
    const dismissTo = vi.fn();
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });
    expect(dismissTo).not.toHaveBeenCalled();

    const root = createNavigationRef({ ready: false });
    const unregister = registerWorkspaceRouteNavigationRef(root.navigationRef);
    expect(dismissTo).not.toHaveBeenCalled();
    root.becomeReady();
    expect(dismissTo).toHaveBeenCalledExactlyOnceWith("/h/server-1/workspace/workspace-a");
    unregister();
  });

  it("keeps only the latest route intent while the root navigator is unavailable", () => {
    const { navigationRef, becomeReady } = createNavigationRef({ ready: false });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const firstDismissTo = vi.fn();
    const latestDismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", {
      dismissTo: firstDismissTo,
    });
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-b", {
      dismissTo: latestDismissTo,
    });
    becomeReady();

    expect(firstDismissTo).not.toHaveBeenCalled();
    expect(latestDismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-b");
  });

  it("preserves a pending route intent across root navigator re-registration", () => {
    const first = createNavigationRef({ ready: false });
    const unregisterFirst = registerWorkspaceRouteNavigationRef(first.navigationRef);
    const dismissTo = vi.fn();
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    unregisterFirst();
    first.becomeReady();
    expect(dismissTo).not.toHaveBeenCalled();

    const replacement = createNavigationRef();
    registerWorkspaceRouteNavigationRef(replacement.navigationRef);

    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });
});

describe("getFocusedWorkspaceSelection", () => {
  function focus(currentRoute?: { name: string; params?: object }) {
    registerWorkspaceRouteNavigationRef(createNavigationRef({ currentRoute }).navigationRef);
  }

  it("returns the workspace on screen", () => {
    focus({
      name: "workspace/[workspaceId]/index",
      params: { serverId: "server-1", workspaceId: "workspace-a" },
    });

    expect(getFocusedWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
  });

  it("returns null when a non-workspace screen is focused", () => {
    focus({ name: "settings/[section]", params: { section: "general" } });

    expect(getFocusedWorkspaceSelection()).toBeNull();
  });
});
