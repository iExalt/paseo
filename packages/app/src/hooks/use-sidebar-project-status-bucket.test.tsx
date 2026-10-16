/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import * as viewModel from "./sidebar-workspaces-view-model";
import { useSidebarProjectStatusBucket } from "./use-sidebar-workspaces-list";

vi.mock("./sidebar-workspaces-view-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidebar-workspaces-view-model")>();
  return { ...actual, deriveProjectStatusBucket: vi.fn(actual.deriveProjectStatusBucket) };
});

const SERVER_ID = "server-sidebar";
const WORKSPACES: viewModel.SidebarWorkspacePlacement[] = [
  {
    workspaceKey: `${SERVER_ID}:ws`,
    serverId: SERVER_ID,
    workspaceId: "ws",
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
  } as viewModel.SidebarWorkspacePlacement,
];

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

it("derives a collapsed project's status again only when its workspaces or activity change", () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  const derive = vi.mocked(viewModel.deriveProjectStatusBucket);
  renderHook(() => useSidebarProjectStatusBucket({ workspaces: WORKSPACES, enabled: true }));
  const afterMount = derive.mock.calls.length;

  act(() => {
    const head: StreamItem[] = [
      { kind: "assistant_message", id: "live", text: "tick", timestamp: new Date(0) } as StreamItem,
    ];
    useSessionStore.getState().setAgentStreamState(SERVER_ID, "agent", { head });
  });
  expect(derive.mock.calls.length).toBe(afterMount);

  act(() => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [SERVER_ID]: { ...state.sessions[SERVER_ID]!, workspaceAgentActivity: new Map() },
      },
    }));
  });
  expect(derive.mock.calls.length).toBe(afterMount + 1);
});
