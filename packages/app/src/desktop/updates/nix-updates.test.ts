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
    ["no facts yet", { result: null, latest: null }, "unknown"],
    ["latest is the active release", { result: result("check"), latest: v022 }, "current"],
    ["latest is newer", { result: result("check"), latest: v023 }, "available"],
    [
      "a newer release is staged",
      { result: result("stage", { staged: v023 }), latest: v023 },
      "ready",
    ],
    [
      "a release newer than the staged one was published",
      { result: result("check", { staged: v023 }), latest: release("0.2.4", "c") },
      "available",
    ],
    [
      "the app runs an older release than the active one",
      { result: result("activate", { active: v023 }), latest: v023 },
      "restart",
    ],
    [
      "the running app matches the active release",
      {
        result: result("status", {
          active: v023,
          running: { version: "0.2.3", outputPath: v023.outputPath },
        }),
        latest: v023,
      },
      "current",
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
      canStage: false,
      busy: null,
      error: null,
      failed: false,
      flowActive: false,
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

  it("says running agents keep working, applies the update, then restarts", async () => {
    await checkForNixUpdate({ userInitiated: false });
    harness.agents.set("a1", { id: "a1", title: "Fix login", status: "running" });
    harness.agents.set("a2", { id: "a2", title: "Idle one", status: "idle" });
    harness.confirmDialog.mockResolvedValue(true);

    await confirmAndRunNixUpdate();

    expect(harness.confirmDialog).toHaveBeenCalledOnce();
    const dialog = harness.confirmDialog.mock.calls[0][0];
    expect(dialog.destructive).toBeUndefined();
    expect(dialog.confirmLabel).toBe("desktop.updates.nix.updateConfirm");
    expect(dialog.message).toContain('desktop.updates.nix.agentsKeepRunning {"count":1}');
    expect(harness.bridge.activate).toHaveBeenCalledOnce();
    expect(harness.bridge.restart).toHaveBeenCalledWith();
  });

  it("runs one flow when the sidebar and Settings both start it", async () => {
    await checkForNixUpdate({ userInitiated: false });
    harness.confirmDialog.mockResolvedValue(true);

    await Promise.all([confirmAndRunNixUpdate(), confirmAndRunNixUpdate()]);

    expect(harness.confirmDialog).toHaveBeenCalledOnce();
    expect(harness.bridge.restart).toHaveBeenCalledOnce();
  });

  it("asks again when a newer release lands while the update is applied", async () => {
    harness.bridge.check.mockResolvedValue(result("check", { latest: v023, canStage: false }));
    await checkForNixUpdate({ userInitiated: false });
    harness.confirmDialog.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const v024 = { ...v023, version: "0.2.4" };
    harness.bridge.activate.mockResolvedValue(result("activate", { active: v024 }));

    await confirmAndRunNixUpdate();

    expect(harness.confirmDialog).toHaveBeenCalledTimes(2);
    expect(harness.bridge.restart).not.toHaveBeenCalled();
  });
});
