import { describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: bridge.invoke }));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
import { getDesktopDaemonStatus } from "./desktop-daemon";

describe("desktop daemon upgrade bridge", () => {
  it.each(["checking", "waiting", "upgrading", "failed", "unsupported"])(
    "preserves %s state from the main process",
    async (phase) => {
      const upgrade = {
        phase,
        serverId: "local",
        pid: 42,
        startedAt: "start",
        targetVersion: "0.23.0",
        error: null,
      };
      bridge.invoke.mockResolvedValue({ serverId: "local", status: "running", upgrade });
      expect((await getDesktopDaemonStatus()).upgrade).toEqual(upgrade);
    },
  );
  it("ignores an unrecognized upgrade payload without changing daemon status", async () => {
    bridge.invoke.mockResolvedValue({
      serverId: "local",
      status: "running",
      upgrade: { phase: "future" },
    });
    expect(await getDesktopDaemonStatus()).toMatchObject({ status: "running", upgrade: null });
  });
});
