import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../output/index.js";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import { toWorkspaceRow, workspaceSchema } from "./shared.js";

const setWorkspaceNotifications = vi.fn(
  async (_workspaceId: string, notifications: "on" | "off") => ({
    notifications,
  }),
);
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
  connectToDaemon: vi.fn(async () => ({ createWorkspace, setWorkspaceNotifications, close })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

import { runUpdateCommand } from "./update.js";
import { createWorkspaceCommand } from "./index.js";

describe("workspace notification update command", () => {
  beforeEach(() => {
    createWorkspace.mockClear();
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
