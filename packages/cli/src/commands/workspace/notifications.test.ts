import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../output/index.js";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import { toWorkspaceRow, workspaceSchema } from "./shared.js";

const setWorkspaceNotifications = vi.fn(
  async (_workspaceId: string, notifications: "on" | "off") => ({
    notifications,
  }),
);
const updateWorkspaceSettings = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
  background: patch.background ?? false,
  title: patch.title ?? null,
  notifications: patch.notifications ?? "on",
  pinnedAt: patch.pinned ? "2026-11-05T00:00:00.000Z" : null,
  labels: patch.addLabels ?? [],
}));
const createWorkspace = vi.fn(async () => ({
  workspace: {
    id: "ws-created",
    projectDisplayName: "Paseo",
    name: "repo",
    workspaceDirectory: "/repo",
    workspaceKind: "directory",
    notifications: "off" as const,
  },
}));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    createWorkspace,
    setWorkspaceNotifications,
    updateWorkspaceSettings,
    close,
    fetchAgent: async () => null,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

import { runUpdateCommand } from "./update.js";
import { createWorkspaceCommand } from "./index.js";

describe("workspace notification update command", () => {
  beforeEach(() => {
    createWorkspace.mockClear();
    updateWorkspaceSettings.mockClear();
    setWorkspaceNotifications.mockClear();
    close.mockClear();
  });

  it("forwards valid create and update options through registered CLI actions", async () => {
    const workspace = createWorkspaceCommand();

    await workspace.parseAsync(
      ["create", "--isolation", "local", "--path", "/repo", "--notifications", "off"],
      { from: "user" },
    );
    await workspace.parseAsync(["update", "ws-created", "--notifications", "off"], {
      from: "user",
    });

    expect(createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: "/repo" },
      notifications: "off",
    });
    expect(setWorkspaceNotifications).toHaveBeenCalledWith("ws-created", "off");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("sends all settings in one request through the registered CLI action", async () => {
    await createWorkspaceCommand().parseAsync(
      [
        "update",
        "ws-1",
        "--no-background",
        "--title",
        "Review",
        "--notifications",
        "off",
        "--pin",
        "--add-label",
        "Ready",
        "--add-label",
        "Review",
        "--remove-label",
        "Done",
      ],
      { from: "user" },
    );
    expect(updateWorkspaceSettings).toHaveBeenCalledExactlyOnceWith("ws-1", {
      background: false,
      title: "Review",
      notifications: "off",
      pinned: true,
      addLabels: ["Ready", "Review"],
      removeLabels: ["Done"],
    });
    expect(setWorkspaceNotifications).not.toHaveBeenCalled();
  });

  it("keeps omitted booleans absent and supports resets", async () => {
    await createWorkspaceCommand().parseAsync(["update", "ws-1", "--reset-title", "--unpin"], {
      from: "user",
    });
    expect(updateWorkspaceSettings).toHaveBeenCalledExactlyOnceWith("ws-1", {
      title: null,
      pinned: false,
    });
  });

  it.each([
    [],
    ["--background", "--no-background"],
    ["--pin", "--unpin"],
    ["--title", "Review", "--reset-title"],
    ["--title", "  "],
    ["--add-label", " Review ", "--remove-label", "review"],
    ["--add-label", "  "],
  ])("rejects empty or conflicting patches before connecting: %j", async (...flags) => {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    const update = workspace.commands.find((command) => command.name() === "update")!;
    update.exitOverride();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exit");
    });
    try {
      await expect(
        workspace.parseAsync(["update", "ws-1", ...flags], { from: "user" }),
      ).rejects.toThrow();
      expect(updateWorkspaceSettings).not.toHaveBeenCalled();
      expect(setWorkspaceNotifications).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("returns the policy acknowledged by the daemon in structured and human output", async () => {
    const result = await runUpdateCommand(
      "ws-1",
      {
        daemonTarget: { kind: "instance", home: "/tmp/workspace-update-test" },
        notifications: "off",
      },
      {} as never,
    );

    expect(setWorkspaceNotifications).toHaveBeenCalledWith("ws-1", "off");
    expect(
      JSON.parse(render(result, { format: "json", quiet: false, noHeaders: false, noColor: true })),
    ).toEqual({
      workspaceId: "ws-1",
      notifications: "off",
    });
    expect(
      render(result, { format: "table", quiet: false, noHeaders: false, noColor: true }),
    ).toContain("off");
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves unsupported-host errors for the CLI output", async () => {
    setWorkspaceNotifications.mockRejectedValueOnce(
      new Error("Update the host to manage workspace notifications."),
    );

    await expect(
      runUpdateCommand(
        "ws-1",
        {
          daemonTarget: { kind: "instance", home: "/tmp/workspace-update-test" },
          notifications: "on",
        },
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_UPDATE_FAILED",
      message: "Update the host to manage workspace notifications.",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves persistence errors for the CLI output", async () => {
    setWorkspaceNotifications.mockRejectedValueOnce(new Error("workspace file write failed"));

    await expect(
      runUpdateCommand(
        "ws-1",
        {
          daemonTarget: { kind: "instance", home: "/tmp/workspace-update-test" },
          notifications: "off",
        },
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_UPDATE_FAILED",
      message: "workspace file write failed",
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("workspace notification options", () => {
  it("rejects values outside the on/off enum before executing create", () => {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    workspace.commands.find((command) => command.name() === "create")?.exitOverride();

    expect(() =>
      workspace.parse(["create", "--isolation", "local", "--notifications", "sometimes"], {
        from: "user",
      }),
    ).toThrow(/Allowed choices are on, off/);
  });
});

describe("workspace notification list output", () => {
  it("includes the effective policy in JSON and the human table for new and legacy descriptors", () => {
    const legacyDescriptor = WorkspaceDescriptorPayloadSchema.parse({
      id: "ws-legacy",
      projectId: "project-1",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo",
      projectKind: "git",
      workspaceKind: "directory",
      name: "repo",
      status: "running",
      activityAt: "2026-10-01T00:00:00.000Z",
    });
    const optedOutDescriptor = { ...legacyDescriptor, id: "ws-off", notifications: "off" as const };
    const result = {
      type: "list" as const,
      data: [toWorkspaceRow(legacyDescriptor), toWorkspaceRow(optedOutDescriptor)],
      schema: workspaceSchema,
    };

    expect(
      JSON.parse(render(result, { format: "json", quiet: false, noHeaders: false, noColor: true })),
    ).toEqual([
      expect.objectContaining({ workspaceId: "ws-legacy", notifications: "on" }),
      expect.objectContaining({ workspaceId: "ws-off", notifications: "off" }),
    ]);
    expect(
      render(result, { format: "table", quiet: false, noHeaders: false, noColor: true }),
    ).toContain("NOTIFICATIONS");
    expect(
      render(result, { format: "table", quiet: false, noHeaders: false, noColor: true }),
    ).toContain("off");
  });
});
