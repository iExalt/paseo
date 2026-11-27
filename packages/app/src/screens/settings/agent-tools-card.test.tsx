/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { renderHook } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";

const { state, patchConfig, toast } = vi.hoisted(() => ({
  state: {
    config: null as ReturnType<typeof MutableDaemonConfigSchema.parse> | null,
    field: null as "mcp" | "agentTools" | null,
  },
  patchConfig:
    vi.fn<
      (patch: unknown) => Promise<ReturnType<typeof MutableDaemonConfigSchema.parse> | undefined>
    >(),
  toast: { error: vi.fn() },
}));

vi.mock("react-native", () => ({
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    accessibilityLabel,
    testID,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    accessibilityLabel: string;
    testID?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-label": accessibilityLabel,
      "aria-checked": String(value),
      "data-testid": testID,
      onClick: () => onValueChange(!value),
    }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: state.config, patchConfig }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => fakeClient,
}));

const fakeClient = {
  getAgentToolsConfigField: () => state.field,
  on: () => () => undefined,
};

vi.mock("@/contexts/toast-context", () => ({ useToast: () => toast }));
vi.mock("@/agent-skills", () => ({
  useAgentSkills: () => ({ status: null, supported: false, connected: true }),
  hasSelectedSkills: () => false,
  areSkillsInstalled: () => false,
}));
vi.mock("@/desktop/hooks/use-install-status", () => ({
  useCliInstall: () => ({ status: null, available: false }),
}));

vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));

import { AgentToolsCard } from "./agent-tools-card";
import { useOrchestrationSetup } from "@/onboarding/internal/orchestration-setup";

const hosts = [
  {
    field: "agentTools",
    config: (enabled: boolean) => MutableDaemonConfigSchema.parse({ agentTools: { enabled } }),
    patch: (enabled: boolean) => ({ agentTools: { enabled } }),
  },
  {
    field: "mcp",
    config: (enabled: boolean) =>
      MutableDaemonConfigSchema.parse({ mcp: { enabled: true, injectIntoAgents: enabled } }),
    patch: (enabled: boolean) => ({ mcp: { injectIntoAgents: enabled } }),
  },
] as const;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.field = null;
  state.config = null;
  patchConfig.mockReset();
  toast.error.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentToolsCard", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function render(): void {
    act(() => root?.render(<AgentToolsCard serverId="host-1" />));
  }

  function readToggle() {
    return container?.querySelector<HTMLButtonElement>('[role="switch"]');
  }

  it.each(hosts)(
    "uses the $field setting in either direction",
    async ({ field, config, patch }) => {
      state.field = field;
      for (const enabled of [true, false]) {
        state.config = config(enabled);
        patchConfig.mockResolvedValueOnce(config(!enabled));
        render();
        expect(readToggle()?.getAttribute("aria-checked")).toBe(String(enabled));
        await act(async () => readToggle()?.click());
        expect(patchConfig).toHaveBeenLastCalledWith(patch(!enabled));
      }
      expect(patchConfig).toHaveBeenCalledTimes(2);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    { case: "denied", write: () => patchConfig.mockRejectedValueOnce(new Error("denied")) },
    { case: "ignored", write: () => patchConfig.mockResolvedValueOnce(hosts[1].config(true)) },
  ])("reports a $case write without retrying", async ({ write }) => {
    state.field = "mcp";
    state.config = hosts[1].config(true);
    write();
    render();

    await act(async () => readToggle()?.click());

    expect(patchConfig).toHaveBeenCalledExactlyOnceWith(hosts[1].patch(false));
    expect(toast.error).toHaveBeenCalledOnce();
    expect(readToggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers no switch when the host has no writable tools setting", () => {
    state.config = MutableDaemonConfigSchema.parse({ mcp: { enabled: true } });
    render();
    expect(readToggle()).toBeNull();
    expect(patchConfig).not.toHaveBeenCalled();
  });
});

describe("Orchestration setup tools", () => {
  it.each(hosts)(
    "writes the $field setting, advancing only after effective readback",
    async ({ field, config, patch }) => {
      state.field = field;
      state.config = config(true);
      const { result } = renderHook(() => useOrchestrationSetup("host-1"));
      expect(result.current.offered.tools).toBe(true);
      act(() => result.current.setChoice("tools", false));

      patchConfig.mockResolvedValueOnce(config(true));
      await act(async () => expect(await result.current.apply()).toBe(false));
      expect(patchConfig).toHaveBeenCalledExactlyOnceWith(patch(false));
      expect(toast.error).toHaveBeenCalledOnce();

      patchConfig.mockResolvedValueOnce(config(false));
      await act(async () => expect(await result.current.apply()).toBe(true));
      expect(patchConfig).toHaveBeenCalledTimes(2);
      expect(patchConfig).toHaveBeenLastCalledWith(patch(false));
    },
  );

  it("preserves legacy global MCP disablement on an attempted enable", async () => {
    state.field = "mcp";
    state.config = MutableDaemonConfigSchema.parse({
      mcp: { enabled: false, injectIntoAgents: false },
    });
    patchConfig.mockResolvedValueOnce(
      MutableDaemonConfigSchema.parse({ mcp: { enabled: false, injectIntoAgents: true } }),
    );
    const { result } = renderHook(() => useOrchestrationSetup("host-1"));

    await act(async () => expect(await result.current.apply()).toBe(false));
    expect(patchConfig).toHaveBeenCalledExactlyOnceWith({ mcp: { injectIntoAgents: true } });
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("reports denied native writes without a legacy retry", async () => {
    state.field = "agentTools";
    state.config = hosts[0].config(false);
    patchConfig.mockRejectedValueOnce(new Error("missing daemon.manage"));
    const { result } = renderHook(() => useOrchestrationSetup("host-1"));

    await act(async () => expect(await result.current.apply()).toBe(false));
    expect(patchConfig).toHaveBeenCalledExactlyOnceWith({ agentTools: { enabled: true } });
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("does not report success if the setting becomes unavailable after the user chose off", async () => {
    state.field = "mcp";
    state.config = hosts[1].config(true);
    const { result, rerender } = renderHook(() => useOrchestrationSetup("host-1"));
    act(() => result.current.setChoice("tools", false));
    state.field = null;
    rerender();

    await act(async () => expect(await result.current.apply()).toBe(false));
    expect(patchConfig).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("continues without writing an unavailable tool setting", async () => {
    state.config = MutableDaemonConfigSchema.parse({});
    const { result } = renderHook(() => useOrchestrationSetup("host-1"));

    expect(result.current.offered.tools).toBe(false);
    await act(async () => expect(await result.current.apply()).toBe(true));
    expect(patchConfig).not.toHaveBeenCalled();
  });
});
