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
const listWorkspaceLabels = vi.fn();
const setWorkspaceLabel = vi.fn();
const updateWorkspaceLabel = vi.fn();
const deleteWorkspaceLabel = vi.fn();
const inspectWorkspaceLabelDelete = vi.fn();
const inspectWorkspaceRecovery = vi.fn();
const restoreWorkspace = vi.fn();
const getLastServerInfoMessage = vi.fn(() => ({
  features: { workspaceLabels: true, workspaceRecovery: true },
}));
const fetchWorkspaces = vi.fn();
const fetchWorkspaceSetupStatus = vi.fn();
const runWorkspaceSetup = vi.fn();
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    listWorkspaceLabels,
    setWorkspaceLabel,
    updateWorkspaceLabel,
    deleteWorkspaceLabel,
    inspectWorkspaceLabelDelete,
    inspectWorkspaceRecovery,
    restoreWorkspace,
    getLastServerInfoMessage,
    fetchWorkspaces,
    fetchWorkspaceSetupStatus,
    runWorkspaceSetup,
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

import { runInspectCommand } from "./inspect.js";
import { runSetupCommand } from "./setup.js";

describe("workspace descriptor inspection", () => {
  const options = {
    daemonTarget: { kind: "instance" as const, home: "/tmp/workspace-inspect-test" },
  };
  const descriptor = WorkspaceDescriptorPayloadSchema.parse({
    id: "ws-rich",
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/repo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "Review",
    status: "running",
    activityAt: "2026-11-01T00:00:00Z",
    project: {
      projectKey: "paseo",
      projectName: "Paseo",
      checkout: {
        cwd: "/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    labels: ["Ready"],
    pinnedAt: "2026-11-01T00:00:00Z",
    setupStatus: "failed",
    diffStat: { additions: 7, deletions: 2 },
    background: true,
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("preserves every descriptor field alongside the established aliases in JSON", () => {
    const row = toWorkspaceRow(descriptor);
    const json = JSON.parse(
      render(
        { type: "list", data: [row], schema: workspaceSchema },
        { format: "json", quiet: false, noHeaders: false, noColor: true },
      ),
    );
    expect(json[0].descriptor).toEqual(descriptor);
    expect(json[0].project).toBe("Paseo");
    expect(json[0].workspaceId).toBe("ws-rich");
  });
  it("finds exact background IDs on later pages", async () => {
    fetchWorkspaces
      .mockResolvedValueOnce({ entries: [], pageInfo: { nextCursor: "next" } })
      .mockResolvedValueOnce({ entries: [descriptor], pageInfo: { nextCursor: null } });
    const result = await runInspectCommand("ws-rich", options, {} as never);
    expect(result.data.descriptor).toEqual(descriptor);
    expect(fetchWorkspaces).toHaveBeenNthCalledWith(2, {
      filter: { includeBackground: true },
      page: { limit: 200, cursor: "next" },
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it("rejects prefixes and closes the connection", async () => {
    fetchWorkspaces.mockResolvedValueOnce({
      entries: [descriptor],
      pageInfo: { nextCursor: null },
    });
    await expect(runInspectCommand("ws", options, {} as never)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it("registers a setup status read without running setup", async () => {
    fetchWorkspaceSetupStatus.mockResolvedValueOnce({ workspaceId: "ws-rich", snapshot: null });
    await createWorkspaceCommand().parseAsync(["setup", "ws-rich", "--status"], { from: "user" });
    expect(fetchWorkspaceSetupStatus).toHaveBeenCalledExactlyOnceWith("ws-rich");
    expect(runWorkspaceSetup).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("preserves the complete setup snapshot", async () => {
    const snapshot = {
      status: "blocked",
      detail: {
        type: "worktree_setup",
        worktreePath: "/repo",
        branchName: "review",
        log: "",
        commands: [],
      },
      error: "Review required",
      blockedSource: {
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "owner/repo",
      },
    };
    fetchWorkspaceSetupStatus.mockResolvedValueOnce({ snapshot });
    const result = await runSetupCommand("ws-rich", { ...options, status: true }, {} as never);
    expect(result.data).toEqual({ workspaceId: "ws-rich", status: "blocked", snapshot });
  });
  it("closes when a setup status read fails", async () => {
    fetchWorkspaceSetupStatus.mockRejectedValueOnce(new Error("missing workspace"));
    await expect(
      runSetupCommand("missing", { ...options, status: true }, {} as never),
    ).rejects.toMatchObject({ code: "WORKSPACE_SETUP_FAILED" });
    expect(close).toHaveBeenCalledOnce();
  });
});

import { runRecoverCommand } from "./recover.js";

describe("workspace label catalog and recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  async function parse(args: string[]) {
    return createWorkspaceCommand().parseAsync(args, { from: "user" });
  }
  it("lists labels and creates with an explicit workspace assignment", async () => {
    listWorkspaceLabels.mockResolvedValueOnce({ labels: [{ name: "Ready", color: "sky" }] });
    setWorkspaceLabel.mockResolvedValueOnce({
      label: { name: "Ready", color: "sky" },
      workspaceLabels: ["Ready"],
    });
    await parse(["label", "ls"]);
    await parse(["label", "create", "Ready", "--workspace", "ws-1", "--color", "sky"]);
    expect(setWorkspaceLabel).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      label: { name: "Ready", color: "sky" },
      assigned: true,
    });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("renames and recolors in one catalog mutation", async () => {
    updateWorkspaceLabel.mockResolvedValueOnce({
      label: { name: "Blocked", color: "red" },
      affectedWorkspaceCount: 2,
    });
    await parse(["label", "update", "Ready", "--name", "Blocked", "--color", "red"]);
    expect(updateWorkspaceLabel).toHaveBeenCalledExactlyOnceWith({
      name: "Ready",
      newName: "Blocked",
      color: "red",
    });
  });
  it("inspects deletion separately from confirmed deletion", async () => {
    inspectWorkspaceLabelDelete.mockResolvedValueOnce({ affectedWorkspaceCount: 2 });
    deleteWorkspaceLabel.mockResolvedValueOnce({ affectedWorkspaceCount: 2 });
    await parse(["label", "delete", "Ready", "--inspect"]);
    expect(deleteWorkspaceLabel).not.toHaveBeenCalled();
    await parse(["label", "delete", "Ready", "--force"]);
    expect(inspectWorkspaceLabelDelete).toHaveBeenCalledExactlyOnceWith({ name: "Ready" });
    expect(deleteWorkspaceLabel).toHaveBeenCalledExactlyOnceWith({ name: "Ready" });
  });
  it.each([
    ["label", "delete", "Needs", "Review", "--force"],
    ["label", "delete", "Ready"],
    ["label", "delete", "Ready", "--force", "--inspect"],
    ["label", "create", "Ready", "--color", "sky"],
    ["label", "create", "Ready", "--workspace", "ws-1", "--color", "invalid"],
    ["label", "update", "Ready"],
    ["label", "update", " ", "--color", "sky"],
  ])("refuses invalid catalog requests before connecting: %j", async (...args) => {
    const workspace = createWorkspaceCommand()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    const label = workspace.commands.find((command) => command.name() === "label")!;
    label.exitOverride();
    for (const command of label.commands) command.exitOverride();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exit");
    });
    try {
      await expect(workspace.parseAsync(args, { from: "user" })).rejects.toThrow();
      expect(getLastServerInfoMessage).not.toHaveBeenCalled();
      expect(deleteWorkspaceLabel).not.toHaveBeenCalled();
      expect(setWorkspaceLabel).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
  it("preserves unavailable recovery state without restoring", async () => {
    const state = {
      kind: "unavailable",
      workspaceId: "ws-1",
      reason: "missing",
      message: "Branch unavailable",
    };
    inspectWorkspaceRecovery.mockResolvedValueOnce(state);
    const result = await runRecoverCommand(
      "ws-1",
      { daemonTarget: { kind: "instance", home: "/tmp/recover-test" }, inspect: true },
      {} as never,
    );
    expect(result.data).toEqual({ workspaceId: "ws-1", restored: false, state });
    expect(restoreWorkspace).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("routes recovery and propagates errors with cleanup", async () => {
    await parse(["recover", "ws-1"]);
    expect(restoreWorkspace).toHaveBeenCalledExactlyOnceWith("ws-1");
    restoreWorkspace.mockRejectedValueOnce(new Error("Restore refused"));
    await expect(
      runRecoverCommand(
        "ws-1",
        { daemonTarget: { kind: "instance", home: "/tmp/recover-test" } },
        {} as never,
      ),
    ).rejects.toThrow("Restore refused");
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("refuses unavailable capabilities and closes connections", async () => {
    getLastServerInfoMessage.mockReturnValueOnce({
      features: { workspaceLabels: false, workspaceRecovery: true },
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("CLI exit");
    });
    try {
      await expect(parse(["label", "ls"])).rejects.toThrow();
      expect(listWorkspaceLabels).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      exit.mockRestore();
    }
  });
});
