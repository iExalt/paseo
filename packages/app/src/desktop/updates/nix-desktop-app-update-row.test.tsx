/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  bridge: {
    check: vi.fn(),
    status: vi.fn(),
    stage: vi.fn(),
    activate: vi.fn(),
  },
  daemonStatus: vi.fn(),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Text: ({ children, testID }: React.ComponentProps<typeof actual.Text>) =>
      React.createElement("span", testID ? { "data-testid": testID } : undefined, children),
    View: ({ children, testID }: React.ComponentProps<typeof actual.View>) =>
      React.createElement("div", testID ? { "data-testid": testID } : undefined, children),
  };
});

vi.mock("react-i18next", async () => {
  const actual = await vi.importActual<typeof import("react-i18next")>("react-i18next");
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        options ? `${key} ${JSON.stringify(options)}` : key,
    }),
  };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children: React.ReactNode;
      onPress(): void;
      disabled?: boolean;
    }) =>
      ReactModule.createElement("button", { type: "button", onClick: onPress, disabled }, children),
  };
});

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ installationMode: "nix", nixUpdates: harness.bridge }),
}));
vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  getDesktopDaemonStatus: harness.daemonStatus,
}));
vi.mock("./nix-update-flow", () => ({ confirmAndRunNixUpdate: vi.fn() }));
vi.mock("@/styles/settings", () => ({
  settingsStyles: { row: {}, rowBorder: {}, rowContent: {}, rowTitle: {}, rowHint: {} },
}));

import { NixDesktopAppUpdateRow } from "./nix-desktop-app-update-row";
import { useNixUpdateStore } from "./nix-updates";

const prior = {
  releaseTag: "paseo-v0.1.0",
  version: "0.1.0",
  outputPath: "/nix/store/12345678901234567890123456789012-paseo-desktop-0.1.0",
};
const candidate = {
  releaseTag: "paseo-v0.1.1",
  version: "0.1.1",
  outputPath: "/nix/store/23456789012345678901234567890123-paseo-desktop-0.1.1",
};

function result(action: "check" | "status" | "stage" | "activate", overrides = {}) {
  return {
    ok: true as const,
    action,
    active: prior,
    staged: null,
    highWaterVersion: "0.1.0",
    running: { version: "0.1.0", outputPath: prior.outputPath },
    ...overrides,
  };
}

const button = (action: string) =>
  screen.findByRole("button", { name: `desktop.updates.nix.${action}Action` });

describe("Nix desktop About update row", () => {
  beforeEach(() => {
    useNixUpdateStore.setState({
      result: null,
      latest: null,
      daemon: null,
      canStage: false,
      busy: null,
      error: null,
      failed: false,
      flowActive: false,
      lastCheckedAt: null,
    });
    harness.daemonStatus.mockResolvedValue({ status: "stopped" });
    harness.bridge.status.mockResolvedValue(result("status"));
    harness.bridge.check.mockResolvedValue(result("check", { latest: candidate, canStage: true }));
    harness.bridge.stage.mockResolvedValue(result("stage", { staged: candidate }));
    harness.bridge.activate.mockResolvedValue(result("activate", { active: candidate }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers one button that moves from Check to Update to Restart", async () => {
    render(<NixDesktopAppUpdateRow />);
    fireEvent.click(await button("check"));
    fireEvent.click(await button("update"));
    await button("restart");
    expect(harness.bridge.stage).toHaveBeenCalledOnce();
    expect(harness.bridge.activate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("nix-desktop-update-status").textContent).toBe(
      'v0.1.0 · desktop.updates.nix.restartRequired {"version":"v0.1.1"}',
    );
  });

  it("keeps the running version visible when the updater fails", async () => {
    harness.bridge.status.mockRejectedValue(new Error("requires explicit manual migration"));
    render(<NixDesktopAppUpdateRow appVersion="0.1.0" />);
    await screen.findByText(
      'v0.1.0 · desktop.updates.nix.failed {"error":"requires explicit manual migration"}',
    );
    expect((await button("check")).hasAttribute("disabled")).toBe(false);
  });
});
