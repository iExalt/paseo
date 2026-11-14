/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
import { LocalDaemonUpgradeCard } from "./local-daemon-upgrade-card";
import type { DesktopDaemonStatus, DesktopDaemonUpgrade } from "@/desktop/daemon/desktop-daemon";
const status: DesktopDaemonStatus = {
  serverId: "local",
  status: "running",
  pid: 42,
  startedAt: "start",
  listen: null,
  hostname: null,
  home: "",
  version: "0.22.0",
  desktopManaged: true,
  ownedByDesktop: false,
  error: null,
};
const upgrade = (phase: DesktopDaemonUpgrade["phase"]): DesktopDaemonUpgrade => ({
  phase,
  serverId: "local",
  pid: 42,
  startedAt: "start",
  targetVersion: "0.23.0",
  error: null,
});
const waitingStatus: DesktopDaemonStatus = { ...status, upgrade: upgrade("waiting") };
const upgradingStatus: DesktopDaemonStatus = {
  ...status,
  status: "stopped",
  serverId: "",
  upgrade: upgrade("upgrading"),
};
const currentStatus: DesktopDaemonStatus = { ...status, version: "0.23.0", upgrade: null };
const failedStatus: DesktopDaemonStatus = {
  ...status,
  status: "stopped",
  serverId: "",
  upgrade: upgrade("failed"),
};
const replacementStatus: DesktopDaemonStatus = { ...status, pid: 100, upgrade: upgrade("waiting") };
const unsupportedStatus: DesktopDaemonStatus = { ...status, upgrade: upgrade("unsupported") };
afterEach(cleanup);

describe("local daemon upgrade", () => {
  it("shows waiting, upgrading and current without offering an app restart", () => {
    const onRetry = vi.fn();
    const view = render(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={waitingStatus}
        managementEnabled
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("desktop.daemon.upgrade.waiting")).toBeTruthy();
    expect(screen.getByText("v0.22.0 → v0.23.0")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={upgradingStatus}
        managementEnabled
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("desktop.daemon.upgrade.upgrading")).toBeTruthy();
    view.rerender(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={currentStatus}
        managementEnabled
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("desktop.daemon.upgrade.current")).toBeTruthy();
    expect(screen.getByText("v0.23.0")).toBeTruthy();
  });
  it("offers safe retry for a failed upgrade, including after the daemon stopped", async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error("Still unavailable"));
    render(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={failedStatus}
        managementEnabled
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "desktop.daemon.upgrade.retry" }));
    await waitFor(() => expect(screen.getByText("Still unavailable")).toBeTruthy());
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("does not attribute the local upgrade to a remote host or replacement daemon", () => {
    const view = render(
      <LocalDaemonUpgradeCard
        serverId="remote"
        status={waitingStatus}
        managementEnabled
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("desktop.daemon.upgrade.waiting")).toBeNull();
    view.rerender(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={replacementStatus}
        managementEnabled
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("desktop.daemon.upgrade.waiting")).toBeNull();
    expect(screen.getByText("desktop.daemon.upgrade.current")).toBeTruthy();
  });
  it("does not promise an automatic upgrade when desktop management is paused", () => {
    render(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={waitingStatus}
        managementEnabled={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("desktop.daemon.upgrade.waiting")).toBeNull();
    expect(screen.getByText("desktop.daemon.upgrade.current")).toBeTruthy();
  });
  it("explains unsupported idle updates without a retry or restart shortcut", () => {
    render(
      <LocalDaemonUpgradeCard
        serverId="local"
        status={unsupportedStatus}
        managementEnabled
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("desktop.daemon.upgrade.unsupportedHint")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
