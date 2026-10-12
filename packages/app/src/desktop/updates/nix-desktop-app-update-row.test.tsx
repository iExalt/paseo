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
    rollback: vi.fn(),
  },
  confirmDialog: vi.fn(),
}));
const progressKeys = new Set([
  "settings.about.nixUpdates.checkingInProgress",
  "settings.about.nixUpdates.stagingInProgress",
  "settings.about.nixUpdates.activatingInProgress",
  "settings.about.nixUpdates.rollbackInProgress",
]);

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
      t: (key: string, options?: Record<string, unknown>) => {
        if (key.endsWith("InProgress")) {
          return progressKeys.has(key) ? `translated:${key}` : `missing:${key}`;
        }
        return options ? `${key} ${JSON.stringify(options)}` : key;
      },
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
  isElectronRuntime: () => true,
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: harness.confirmDialog }));
vi.mock("@/styles/settings", () => ({
  settingsStyles: { row: {}, rowBorder: {}, rowContent: {}, rowTitle: {}, rowHint: {} },
}));

import { NixDesktopAppUpdateRow } from "./nix-desktop-app-update-row";

const prior = {
  releaseTag: "v0.1.0",
  version: "0.1.0",
  outputPath: "/nix/store/12345678901234567890123456789012-paseo-desktop-0.1.0",
};
const candidate = {
  releaseTag: "v0.1.1",
  version: "0.1.1",
  outputPath: "/nix/store/23456789012345678901234567890123-paseo-desktop-0.1.1",
};
const olderStaged = { ...candidate, releaseTag: "v0.0.9", version: "0.0.9" };

function result(
  action: "check" | "status" | "stage" | "activate" | "rollback",
  overrides: Record<string, unknown> = {},
) {
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

describe("Nix desktop About update row", () => {
  beforeEach(() => {
    harness.bridge.status.mockResolvedValue(result("status"));
    harness.bridge.check.mockResolvedValue(
      result("check", {
        latest: candidate,
        staged: olderStaged,
        canStage: true,
        message: "Update available",
      }),
    );
    harness.bridge.stage.mockResolvedValue(result("stage", { staged: candidate, canStage: false }));
    harness.bridge.activate.mockResolvedValue(
      result("activate", { active: candidate, staged: null, highWaterVersion: "0.1.1" }),
    );
    harness.bridge.rollback.mockResolvedValue(
      result("rollback", { active: prior, staged: null, highWaterVersion: "0.1.1" }),
    );
    harness.confirmDialog.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("checks, stages, confirms activation, and offers rollback without restarting", async () => {
    render(<NixDesktopAppUpdateRow />);
    await screen.findByText('settings.about.nixUpdates.active {"version":"v0.1.0"}');

    fireEvent.click(screen.getByRole("button", { name: "settings.about.nixUpdates.check" }));
    await screen.findByText('settings.about.nixUpdates.latest {"version":"v0.1.1"}');
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "settings.about.nixUpdates.stage",
      }).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "settings.about.nixUpdates.stage" }));
    await screen.findByText('settings.about.nixUpdates.staged {"version":"v0.1.1"}');

    fireEvent.click(screen.getByRole("button", { name: "settings.about.nixUpdates.activate" }));
    await screen.findByText('settings.about.nixUpdates.active {"version":"v0.1.1"}');
    expect(harness.confirmDialog).toHaveBeenCalledOnce();
    expect(screen.getByText("settings.about.nixUpdates.restartRequired")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "settings.about.nixUpdates.rollback" }));
    await screen.findByText('settings.about.nixUpdates.active {"version":"v0.1.0"}');
    expect(harness.confirmDialog).toHaveBeenCalledTimes(2);
    expect(harness.bridge.status).toHaveBeenCalledOnce();
  });

  it("uses an existing translated label while a command is running", async () => {
    render(<NixDesktopAppUpdateRow />);
    await screen.findByText('settings.about.nixUpdates.active {"version":"v0.1.0"}');
    fireEvent.click(screen.getByRole("button", { name: "settings.about.nixUpdates.check" }));
    await screen.findByText('settings.about.nixUpdates.latest {"version":"v0.1.1"}');

    let finishStage!: (value: ReturnType<typeof result>) => void;
    harness.bridge.stage.mockImplementation(
      () => new Promise((resolve) => (finishStage = resolve)),
    );
    fireEvent.click(screen.getByRole("button", { name: "settings.about.nixUpdates.stage" }));
    await screen.findByText("translated:settings.about.nixUpdates.stagingInProgress");
    expect(screen.queryByText("missing:settings.about.nixUpdates.stageInProgress")).toBeNull();
    finishStage(result("stage", { staged: candidate, canStage: false }));
  });
});
