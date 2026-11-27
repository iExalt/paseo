import type { NavigationContainerRefWithCurrent } from "expo-router/react-navigation";
import { router, type Href } from "expo-router";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
const HOST_WORKSPACE_ROUTE_NAME = "workspace/[workspaceId]/index";

interface NavigateToHostWorkspaceRouteDeps {
  dismissTo(route: string): void;
}

const defaultNavigateToHostWorkspaceRouteDeps: NavigateToHostWorkspaceRouteDeps = {
  dismissTo: (route) => router.dismissTo(route as Href),
};

let rootNavigationRef: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null =
  null;
let pendingIntent: { route: string; deps: NavigateToHostWorkspaceRouteDeps } | null = null;

export function registerWorkspaceRouteNavigationRef(
  ref: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>,
): () => void {
  rootNavigationRef = ref;
  const unsubscribe = ref.addListener("state", flushPendingIntent);
  flushPendingIntent();
  return () => {
    unsubscribe();
    if (rootNavigationRef === ref) {
      rootNavigationRef = null;
    }
  };
}

/**
 * The workspace on screen right now, read from the focused route, or null on any other screen
 * (Settings, New workspace, ...). Unlike a component's last render, it stays correct for work that
 * finishes after the screen that started it is gone.
 */
export function getFocusedWorkspaceSelection(): { serverId: string; workspaceId: string } | null {
  // Typed routes narrow the container's route to `never`; this only reads name and params.
  const route = rootNavigationRef?.current?.getCurrentRoute() as
    | { name: string; params?: { serverId?: unknown; workspaceId?: unknown } }
    | undefined;
  if (route?.name !== HOST_WORKSPACE_ROUTE_NAME) {
    return null;
  }
  const params = route.params;
  if (typeof params?.serverId !== "string" || typeof params.workspaceId !== "string") {
    return null;
  }
  const workspaceId = decodeWorkspaceIdFromPathSegment(params.workspaceId);
  return workspaceId ? { serverId: params.serverId, workspaceId } : null;
}

export function navigateToHostWorkspaceRoute(
  route: string,
  deps: NavigateToHostWorkspaceRouteDeps = defaultNavigateToHostWorkspaceRouteDeps,
): void {
  pendingIntent = { route, deps };
  flushPendingIntent();
}

function flushPendingIntent(): void {
  const navigation = rootNavigationRef?.current;
  if (!pendingIntent || !navigation?.isReady()) return;

  const { route, deps } = pendingIntent;
  pendingIntent = null;
  // Expo Router resolves the full href against the mounted stack, including its nested POP_TO.
  deps.dismissTo(route);
}
