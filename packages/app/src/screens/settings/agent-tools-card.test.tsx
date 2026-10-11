/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";

const { state, patchConfig } = vi.hoisted(() => ({
  state: {
    config: undefined as ReturnType<typeof MutableDaemonConfigSchema.parse> | undefined,
  },
  patchConfig: vi.fn(async () => undefined),
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
}));

vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));

import { AgentToolsCard } from "./agent-tools-card";

describe("AgentToolsCard", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.config = undefined;
    patchConfig.mockReset();
    patchConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => root?.render(<AgentToolsCard serverId="host-1" />));
  }

  it("reads legacy settings and persists both native-tools toggle directions", () => {
    state.config = MutableDaemonConfigSchema.parse({
      mcp: { enabled: true, injectIntoAgents: true },
    });
    render();

    let toggle = container?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    act(() => toggle?.click());
    expect(patchConfig).toHaveBeenLastCalledWith({ agentTools: { enabled: false } });

    state.config = MutableDaemonConfigSchema.parse({ agentTools: { enabled: false } });
    render();
    toggle = container?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    act(() => toggle?.click());
    expect(patchConfig).toHaveBeenLastCalledWith({ agentTools: { enabled: true } });
  });
});
