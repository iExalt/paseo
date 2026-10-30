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
    features: {} as Record<string, unknown>,
  },
  patchConfig: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
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
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
    accessibilityLabel: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-label": accessibilityLabel,
      "aria-checked": String(value),
      onClick: () => onValueChange(!value),
    }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: state.config, patchConfig }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (value: {
      sessions: Record<string, { serverInfo: { features: Record<string, unknown> } }>;
    }) => unknown,
  ) => selector({ sessions: { "host-1": { serverInfo: { features: state.features } } } }),
}));

vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));

import { RelayKeepAwakeCard } from "./relay-keep-awake-card";

describe("RelayKeepAwakeCard", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.config = undefined;
    state.features = { relayKeepAwake: true };
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

  function render(relay: { enabled: boolean; keepAwake?: boolean }): void {
    state.config = MutableDaemonConfigSchema.parse({ relay });
    act(() => root?.render(<RelayKeepAwakeCard serverId="host-1" />));
  }

  function hint(): string | undefined {
    return container?.querySelectorAll("span")[1]?.textContent ?? undefined;
  }

  it("stays hidden on daemons that can't hold the assertion", () => {
    state.features = {};
    render({ enabled: true, keepAwake: true });

    expect(container?.innerHTML).toBe("");
  });

  it("reflects the setting, patches only relay.keepAwake, and explains its state", () => {
    render({ enabled: true });
    const toggle = container?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(hint()).toBe("settings.host.pairDevices.keepAwake.hint");

    act(() => toggle?.click());
    expect(patchConfig).toHaveBeenLastCalledWith({ relay: { keepAwake: true } });

    render({ enabled: true, keepAwake: true });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(hint()).toBe("settings.host.pairDevices.keepAwake.activeHint");

    render({ enabled: false, keepAwake: true });
    expect(hint()).toBe("settings.host.pairDevices.keepAwake.waitingHint");
  });
});
