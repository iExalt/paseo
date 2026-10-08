/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot } from "@/components/ui/menu/menu-root";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { WorkspaceNotificationsMenuItem } from "./menu-item";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  setWorkspaceNotifications: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: mocks.getClient }),
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: mocks.toastError }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The menu row imports these native-only form/animation helpers even though this rendered item
// does not use them. Keep the real shared menu engine and replace only those unrelated surfaces.
vi.mock("@/components/adaptive-modal-sheet", () => ({ AdaptiveTextInput: () => null }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  runOnJS: (callback: () => void) => callback,
  FadeIn: {},
  FadeOut: {},
  useAnimatedStyle: (factory: () => unknown) => factory(),
}));

const serverId = "workspace-notifications-menu-test";
const workspaceId = "workspace-1";

function workspace(notifications: "on" | "off" = "on", name = "Main") {
  return normalizeWorkspaceDescriptor({
    id: workspaceId,
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name,
    notifications,
    status: "done",
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  });
}

function renderMenus() {
  return render(
    <>
      <MenuRoot defaultOpen>
        <WorkspaceNotificationsMenuItem
          serverId={serverId}
          workspaceId={workspaceId}
          testID="header-notifications"
        />
      </MenuRoot>
      <MenuRoot defaultOpen>
        <WorkspaceNotificationsMenuItem
          serverId={serverId}
          workspaceId={workspaceId}
          testID="sidebar-notifications"
        />
      </MenuRoot>
    </>,
  );
}

function setupSession(supported: boolean) {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: "test host",
    version: "1.0.0",
    features: supported ? { workspaceNotifications: true } : {},
  });
  store.mergeWorkspaces(serverId, [workspace()]);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getClient.mockReturnValue({ setWorkspaceNotifications: mocks.setWorkspaceNotifications });
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(serverId);
  vi.clearAllMocks();
});

describe("workspace notification menu item", () => {
  it("renders the authoritative policy in both menu surfaces", () => {
    setupSession(true);
    act(() => {
      useSessionStore.getState().mergeWorkspaces(serverId, [workspace("off")]);
    });
    renderMenus();

    expect(screen.getByTestId("header-notifications").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("sidebar-notifications").getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText("sidebar.workspace.actions.unmuteNotifications")).toHaveLength(2);

    act(() => {
      useSessionStore.getState().mergeWorkspaces(serverId, [workspace("on")]);
    });
    expect(screen.getAllByText("sidebar.workspace.actions.muteNotifications")).toHaveLength(2);
  });

  it("shares pending state and does not let a delayed ACK overwrite a live descriptor", async () => {
    setupSession(true);
    let resolveMutation!: (value: { notifications: "on" | "off" }) => void;
    mocks.setWorkspaceNotifications.mockReturnValueOnce(
      new Promise<{ notifications: "on" | "off" }>((resolve) => {
        resolveMutation = resolve;
      }),
    );
    renderMenus();

    await act(async () => {
      fireEvent.click(screen.getByTestId("header-notifications"));
      fireEvent.click(screen.getByTestId("sidebar-notifications"));
      await Promise.resolve();
    });
    expect(mocks.setWorkspaceNotifications).toHaveBeenCalledTimes(1);
    expect(mocks.setWorkspaceNotifications).toHaveBeenCalledWith(workspaceId, "off");
    expect(screen.getByTestId("header-notifications").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("sidebar-notifications").getAttribute("aria-disabled")).toBe("true");

    act(() => {
      useSessionStore.getState().mergeWorkspaces(serverId, [workspace("on", "Newer name")]);
    });
    await act(async () => {
      resolveMutation({ notifications: "off" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useSessionStore.getState().sessions[serverId]?.workspaces.get(workspaceId),
    ).toMatchObject({
      name: "Newer name",
      notifications: "on",
    });
    expect(screen.getByTestId("header-notifications").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
    expect(screen.getByTestId("sidebar-notifications").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
  });

  it("keeps the authoritative state on failure and explains an unsupported host", async () => {
    setupSession(true);
    mocks.setWorkspaceNotifications.mockRejectedValueOnce(new Error("write rejected"));
    renderMenus();

    await act(async () => {
      fireEvent.click(screen.getByTestId("header-notifications"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastError).toHaveBeenCalledWith("write rejected");
    expect(
      useSessionStore.getState().sessions[serverId]?.workspaces.get(workspaceId)?.notifications,
    ).toBe("on");
    expect(screen.getByTestId("header-notifications").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-notifications"));
      await Promise.resolve();
    });
    expect(mocks.setWorkspaceNotifications).toHaveBeenCalledTimes(2);

    act(() => {
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: "test host",
        version: "1.0.0",
        features: {},
      });
    });
    expect(screen.getByTestId("header-notifications").getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getAllByText("sidebar.workspace.actions.updateHostForNotifications"),
    ).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-notifications"));
    });
    expect(mocks.setWorkspaceNotifications).toHaveBeenCalledTimes(2);
  });
});
