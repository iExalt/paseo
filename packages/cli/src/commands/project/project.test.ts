import { runProjectConfig } from "./config.js";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectPath, runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { createProjectCommand } from "./index.js";
import { runLsCommand } from "./ls.js";
import { resolveProjectName, runRenameCommand } from "./rename.js";

const project = {
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectCustomName: null,
  projectRootPath: "/tmp/paseo",
  projectKind: "git" as const,
};
const addProject = vi.fn(async () => ({ project, error: null }));
const listProjects = vi.fn(async () => ({ projects: [project] }));
const renameProject = vi.fn(async (_projectId: string, name: string | null) => ({
  customName: name,
}));
const removeProject = vi.fn(async () => ({ removedWorkspaceIds: ["workspace-1"] }));
const createProjectDirectory = vi.fn(async () => ({
  project,
  error: null,
  directoryPath: "/srv/new",
}));
const getLastServerInfoMessage = vi.fn(() => ({ features: { projectCreateDirectory: true } }));
const readProjectConfig = vi.fn(async () => ({
  ok: true,
  requestId: "r",
  repoRoot: "/canonical/repo",
  config: null,
  revision: null,
}));
const writeProjectConfig = vi.fn(async () => ({
  ok: true,
  requestId: "w",
  repoRoot: "/canonical/repo",
  config: {},
  revision: { mtimeMs: 2, size: 2 },
}));
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  buildDaemonConnectionCommandError: vi.fn(({ error }: { error: unknown }) => error),
  connectToDaemon: vi.fn(async () => ({
    addProject,
    createProjectDirectory,
    getLastServerInfoMessage,
    readProjectConfig,
    writeProjectConfig,
    listProjects,
    renameProject,
    removeProject,
    close,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project commands", () => {
  it("exposes the complete project lifecycle", () => {
    expect(createProjectCommand().commands.map((command) => command.name())).toEqual([
      "create",
      "ls",
      "rename",
      "delete",
      "config",
    ]);
  });

  it("creates a project from an absolute directory path", async () => {
    const result = await runCreateCommand(
      "relative/project",
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );

    expect(addProject).toHaveBeenCalledWith(path.resolve("relative/project"));
    expect(result.data).toEqual({
      projectId: "project-1",
      name: "Paseo",
      kind: "git",
      path: "/tmp/paseo",
    });
    expect(close).toHaveBeenCalled();
  });

  it("resolves paths locally and leaves daemon-owned paths unchanged", () => {
    expect(resolveProjectPath({ cwd: "/home/user", pathArg: "repo" })).toBe(
      path.resolve("/home/user/repo"),
    );
    expect(resolveProjectPath({ cwd: "/home/user" })).toBe(path.resolve("/home/user"));
    expect(
      resolveProjectPath({ cwd: "/home/user", pathArg: "/srv/repo", daemonTarget: "host:6767" }),
    ).toBe("/srv/repo");
    expect(
      resolveProjectPath({ cwd: "/home/user", pathArg: "~/repo", daemonTarget: "host:6767" }),
    ).toBe("~/repo");
  });

  it("requires a daemon-owned path for an explicit target", () => {
    expect(() => resolveProjectPath({ cwd: "/home/user", daemonTarget: "host:6767" })).toThrow();
  });

  it("lists projects", async () => {
    const result = await runLsCommand(
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );

    expect(listProjects).toHaveBeenCalled();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.projectId).toBe("project-1");
  });

  it("renames and resets a project", async () => {
    expect(resolveProjectName({ name: "  New name  " })).toBe("New name");
    expect(resolveProjectName({ reset: true })).toBeNull();

    const result = await runRenameCommand(
      "project-1",
      "  New name  ",
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );
    expect(renameProject).toHaveBeenCalledWith("project-1", "New name");
    expect(result.data).toEqual({ projectId: "project-1", name: "New name" });
  });

  it("rejects an empty project name", () => {
    expect(() => resolveProjectName({ name: "  " })).toThrow();
  });

  it("deletes a project", async () => {
    const result = await runDeleteCommand(
      "project-1",
      { daemonTarget: { kind: "instance", home: "/tmp/project-test" } },
      {} as never,
    );

    expect(removeProject).toHaveBeenCalledWith("project-1");
    expect(result.data).toEqual({
      projectId: "project-1",
      removedWorkspaceIds: ["workspace-1"],
    });
  });
});

describe("project configuration and setup", () => {
  const options = { daemonTarget: { kind: "endpoint" as const, host: "remote:123" } };
  it("creates and registers a directory through the host without adding it twice", async () => {
    const result = await runCreateCommand(
      "new",
      { ...options, mkdir: true, parent: "C:\\work" },
      {} as never,
    );
    expect(createProjectDirectory).toHaveBeenCalledWith({ parentPath: "C:\\work", name: "new" });
    expect(addProject).not.toHaveBeenCalled();
    expect(result.data.projectId).toBe("project-1");
  });
  it("rejects directory creation before mutation on an older host", async () => {
    getLastServerInfoMessage.mockReturnValueOnce({ features: { projectCreateDirectory: false } });
    await expect(
      runCreateCommand("new", { ...options, mkdir: true, parent: "/srv" }, {} as never),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    expect(createProjectDirectory).not.toHaveBeenCalled();
  });
  it("returns the missing config and revision without inventing defaults", async () => {
    const result = await runProjectConfig("get", undefined, { ...options, project: "project-1" });
    expect(readProjectConfig).toHaveBeenCalledWith("/tmp/paseo");
    expect(result.data).toMatchObject({ config: null, revision: null });
  });
  it("uses the read's canonical root and revision for an intentional replacement", async () => {
    await runProjectConfig("set", '{"worktree":{"setup":"echo setup"}}', {
      ...options,
      path: "/alias",
    });
    expect(writeProjectConfig).toHaveBeenCalledWith({
      repoRoot: "/canonical/repo",
      expectedRevision: null,
      config: { worktree: { setup: "echo setup" } },
    });
  });
  it("forwards explicit revisions and preserves stale-write errors", async () => {
    writeProjectConfig.mockResolvedValueOnce({
      ok: false,
      requestId: "w",
      repoRoot: "/canonical/repo",
      error: { code: "stale_project_config", currentRevision: { mtimeMs: 3, size: 3 } },
    } as never);
    await expect(
      runProjectConfig("set", "{}", {
        ...options,
        path: "/repo",
        revision: '{"mtimeMs":1,"size":1}',
      }),
    ).rejects.toMatchObject({
      code: "stale_project_config",
      currentRevision: { mtimeMs: 3, size: 3 },
    });
    expect(writeProjectConfig).toHaveBeenCalledWith({
      repoRoot: "/canonical/repo",
      config: {},
      expectedRevision: { mtimeMs: 1, size: 1 },
    });
  });
  it("rejects failed reads and unknown or ambiguous project selectors without writing", async () => {
    await expect(runProjectConfig("get", undefined, options)).rejects.toThrow();
    await expect(
      runProjectConfig("get", undefined, { ...options, path: "/repo", project: "project-1" }),
    ).rejects.toThrow();
    await expect(
      runProjectConfig("set", "{}", { ...options, project: "missing" }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    readProjectConfig.mockResolvedValueOnce({
      ok: false,
      requestId: "r",
      repoRoot: "/repo",
      error: { code: "invalid_project_config" },
    } as never);
    await expect(
      runProjectConfig("set", "{}", { ...options, path: "/repo" }),
    ).rejects.toMatchObject({ code: "invalid_project_config" });
    expect(writeProjectConfig).not.toHaveBeenCalled();
  });
});
