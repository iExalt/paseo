import { describe, expect, it, vi } from "vitest";
import { assertModeBeforeWorkspaceCreate } from "./run-mode-check.js";

const snapshot = {
  entries: [
    {
      provider: "codex",
      modes: [
        { id: "auto", label: "Default Permissions" },
        { id: "full-access", label: "Full Access" },
      ],
    },
  ],
};
const client = (value = snapshot) => ({ getProvidersSnapshot: vi.fn(async () => value) });

describe("assertModeBeforeWorkspaceCreate", () => {
  it("accepts a listed mode id and an omitted mode", async () => {
    await expect(assertModeBeforeWorkspaceCreate(client(), "codex", "full-access")).resolves.toBe(
      undefined,
    );
    const noMode = client();
    await expect(assertModeBeforeWorkspaceCreate(noMode, "codex", undefined)).resolves.toBe(
      undefined,
    );
    expect(noMode.getProvidersSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode and points a label at its id", async () => {
    await expect(assertModeBeforeWorkspaceCreate(client(), "codex", "turbo")).rejects.toMatchObject(
      {
        code: "INVALID_MODE",
        message: "Invalid mode 'turbo' for provider 'codex'. Available modes: auto, full-access",
      },
    );
    await expect(
      assertModeBeforeWorkspaceCreate(client(), "codex", "Full Access"),
    ).rejects.toMatchObject({
      code: "INVALID_MODE",
      message: expect.stringContaining("use the mode id 'full-access'"),
    });
  });

  it("fails open when the snapshot is unavailable or lists no modes", async () => {
    const failing = {
      getProvidersSnapshot: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    await expect(assertModeBeforeWorkspaceCreate(failing, "codex", "turbo")).resolves.toBe(
      undefined,
    );
    await expect(
      assertModeBeforeWorkspaceCreate(client({ entries: [] }), "codex", "turbo"),
    ).resolves.toBe(undefined);
  });
});
