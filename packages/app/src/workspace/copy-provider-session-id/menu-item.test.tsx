/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot } from "@/components/ui/menu/menu-root";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { CopyProviderSessionIdMenuItem } from "./menu-item";

const mocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(),
  toastCopied: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ copied: mocks.toastCopied, error: mocks.toastError }),
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

const serverId = "copy-provider-session-id-menu-test";
const testID = "copy-provider-session-id";

function setAgentSession(sessionId: string | null) {
  const agent: Agent = {
    serverId,
    id: "agent-1",
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: sessionId ? { provider: "codex", sessionId } : null,
    title: "Agent",
    cwd: "/repo",
    workspaceId: "workspace-1",
    model: null,
    archivedAt: null,
    parentAgentId: null,
    labels: {},
  };
  act(() => {
    useSessionStore.getState().setAgents(serverId, new Map([[agent.id, agent]]));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
  mocks.setStringAsync.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(serverId);
  vi.clearAllMocks();
});

describe("copy provider session ID menu item", () => {
  it("appears once the workspace's agent has a session and copies it", async () => {
    setAgentSession(null);
    render(
      <MenuRoot defaultOpen>
        <CopyProviderSessionIdMenuItem
          serverId={serverId}
          workspaceId="workspace-1"
          testID={testID}
          leading={null}
        />
      </MenuRoot>,
    );
    expect(screen.queryByTestId(testID)).toBeNull();

    setAgentSession("thread-123");
    await act(async () => {
      fireEvent.click(screen.getByTestId(testID));
      await Promise.resolve();
    });

    expect(mocks.setStringAsync).toHaveBeenCalledWith("thread-123");
    expect(mocks.toastCopied).toHaveBeenCalledWith(
      "workspace.header.toasts.providerSessionIdCopiedLabel",
    );
  });
});
