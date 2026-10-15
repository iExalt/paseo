import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  bridge: {
    check: vi.fn(),
    status: vi.fn(),
    stage: vi.fn(),
    activate: vi.fn(),
    restart: vi.fn(),
  },
  daemonStatus: vi.fn(),
  confirmDialog: vi.fn(),
  agents: new Map<string, { id: string; title: string | null; status: string }>(),
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ installationMode: "nix", nixUpdates: harness.bridge }),
}));
vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  getDesktopDaemonStatus: harness.daemonStatus,
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: harness.confirmDialog }));
vi.mock("@/i18n/i18next", () => ({
  i18n: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({ sessions: { local: { agents: harness.agents } } }),
  },
}));

import { confirmAndRunNixUpdate } from "./nix-update-flow";
import {
  checkForNixUpdate,
  resolveNixUpdatePhase,
  useNixUpdateStore,
  type NixUpdateFacts,
} from "./nix-updates";

const release = (version: string, hash: string) => ({
  releaseTag: `paseo-v${version}`,
  version,
  outputPath: `/nix/store/${hash.repeat(32)}-paseo-desktop-${version}`,
});
const v022 = release("0.2.2", "a");
const v023 = release("0.2.3", "b");

function result(action: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    action: action as "status",
    active: v022,
    staged: null,
    highWaterVersion: "0.2.2",
    running: { version: "0.2.2", outputPath: v022.outputPath },
    ...overrides,
  };
}

const daemon = {
  serverId: "local",
  status: "running",
  pid: 42,
  startedAt: "2026-10-15T00:00:00.000Z",
  version: "0.2.2",
  desktopManaged: true,
};

describe("Nix update phase", () => {
  it.each<[string, NixUpdateFacts, string]>([
    ["no facts yet", { result: null, latest: null, daemon: null }, "unknown"],
    ["latest is the active release", { result: result("check"), latest: v022, daemon }, "current"],
    ["latest is newer", { result: result("check"), latest: v023, daemon }, "available"],
    [
      "a newer release is staged",
      { result: result("stage", { staged: v023 }), latest: v023, daemon },
      "ready",
    ],
    [
      "the app runs an older release than the active one",
      { result: result("activate", { active: v023 }), latest: v023, daemon },
      "restart",
    ],
    [
      "only the app was relaunched, so the desktop daemon is still old",
      {
        result: result("status", {
          active: v023,
          running: { version: "0.2.3", outputPath: v023.outputPath },
        }),
        latest: v023,
        daemon,
      },
      "restart",
    ],
  ])("is right when %s", (_case, facts, kind) => {
    expect(resolveNixUpdatePhase(facts).kind).toBe(kind);
  });
});

describe("Nix update operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.agents.clear();
    useNixUpdateStore.setState({
      result: null,
      latest: null,
      daemon: null,
      canStage: false,
      busy: null,
      error: null,
      failed: false,
      lastCheckedAt: null,
    });
    harness.daemonStatus.mockResolvedValue(daemon);
    harness.bridge.check.mockResolvedValue(result("check", { latest: v023, canStage: true }));
    harness.bridge.stage.mockResolvedValue(result("stage", { staged: v023, canStage: false }));
    harness.bridge.activate.mockResolvedValue(result("activate", { active: v023 }));
    harness.bridge.restart.mockResolvedValue(undefined);
  });

  it("downloads a newer release in the background without applying it", async () => {
    await checkForNixUpdate({ userInitiated: false });
    expect(harness.bridge.stage).toHaveBeenCalledOnce();
    expect(harness.bridge.activate).not.toHaveBeenCalled();
    expect(resolveNixUpdatePhase(useNixUpdateStore.getState()).kind).toBe("ready");
  });

  it("warns about running agents, applies the update, then restarts the confirmed daemon", async () => {
    await checkForNixUpdate({ userInitiated: false });
    harness.agents.set("a1", { id: "a1", title: "Fix login", status: "running" });
    harness.agents.set("a2", { id: "a2", title: "Idle one", status: "idle" });
    harness.confirmDialog.mockResolvedValue(true);

    await confirmAndRunNixUpdate();

    expect(harness.confirmDialog).toHaveBeenCalledOnce();
    const dialog = harness.confirmDialog.mock.calls[0][0];
    expect(dialog.destructive).toBe(true);
    expect(dialog.message).toContain("• Fix login");
    expect(dialog.message).not.toContain("Idle one");
    expect(harness.bridge.activate).toHaveBeenCalledOnce();
    expect(harness.bridge.restart).toHaveBeenCalledWith({
      pid: 42,
      startedAt: daemon.startedAt,
    });
  });

  it("asks again when an agent starts while the update is applied", async () => {
    harness.bridge.check.mockResolvedValue(result("check", { latest: v023, canStage: false }));
    await checkForNixUpdate({ userInitiated: false });
    harness.confirmDialog.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    harness.bridge.stage.mockImplementation(async () => {
      harness.agents.set("late", { id: "late", title: "Started late", status: "running" });
      return result("stage", { staged: v023 });
    });

    await confirmAndRunNixUpdate();

    expect(harness.confirmDialog).toHaveBeenCalledTimes(2);
    expect(harness.confirmDialog.mock.calls[0][0].destructive).toBe(false);
    expect(harness.confirmDialog.mock.calls[1][0].message).toContain("• Started late");
    expect(harness.bridge.restart).not.toHaveBeenCalled();
  });
});
