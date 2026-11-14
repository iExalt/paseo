import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildWorkspaceSource } from "./create.js";

const createWorkspace = vi.fn(async () => ({
  workspace: {
    id: "ws-created",
    projectDisplayName: "Paseo",
    name: "feature",
    workspaceDirectory: "/repo/worktree",
    workspaceKind: "worktree",
    notifications: "off" as const,
  },
}));
const close = vi.fn(async () => undefined);
const listProjects = vi.fn(async () => ({ projects: [] }));

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ createWorkspace, close, listProjects })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

import { runCreateCommand } from "./create.js";

describe("workspace create source", () => {
  it("passes the notification policy in the workspace creation request and result", async () => {
    const result = await runCreateCommand(
      {
        daemonTarget: { kind: "instance", home: "/tmp/workspace-create-test" },
        isolation: "worktree",
        path: "/repo",
        notifications: "off",
      },
      {} as never,
    );

    expect(createWorkspace).toHaveBeenCalledWith({
      source: { kind: "worktree", cwd: "/repo", action: "branch-off" },
      notifications: "off",
    });
    expect(result.data).toMatchObject({ workspaceId: "ws-created", notifications: "off" });
    expect(close).toHaveBeenCalledOnce();
    expect(listProjects).toHaveBeenCalledOnce();
    createWorkspace.mockClear();
    close.mockClear();
  });

  it("maps local isolation to a directory workspace", () => {
    expect(
      buildWorkspaceSource({ isolation: "local", path: "/tmp/project", project: "project-1" }),
    ).toEqual({ kind: "directory", path: "/tmp/project", projectId: "project-1" });
  });

  it("keeps branch names separate from managed worktree slugs", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "branch-off",
        newBranch: "feature/auth",
        worktreeSlug: "feature-auth",
        base: "main",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "branch-off",
      branchName: "feature/auth",
      worktreeSlug: "feature-auth",
      baseBranch: "main",
    });
  });

  it("uses a project as the worktree source without capturing the ambient directory", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        project: "project-1",
        mode: "branch-off",
        newBranch: "fix-x",
      }),
    ).toEqual({
      kind: "worktree",
      projectId: "project-1",
      action: "branch-off",
      branchName: "fix-x",
    });
  });

  it("checks out an existing branch into a worktree workspace", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-branch",
        branch: "existing-work",
        worktreeSlug: "existing-work-copy",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      refName: "existing-work",
      worktreeSlug: "existing-work-copy",
    });
  });

  it("checks out a pull request into a worktree workspace", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-pr",
        prNumber: "42",
        forge: "gitlab",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        forge: "gitlab",
        number: 42,
      },
    });
  });

  it("lets the source checkout select the forge when it is omitted", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-pr",
        prNumber: "42",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        number: 42,
      },
    });
  });

  it("requires the mode-specific checkout target", () => {
    expect(() => buildWorkspaceSource({ isolation: "worktree", mode: "checkout-branch" })).toThrow(
      "--branch is required",
    );
    expect(() => buildWorkspaceSource({ isolation: "worktree", mode: "checkout-pr" })).toThrow(
      "--pr-number is required",
    );
  });

  it("rejects worktree options for local isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "local", mode: "branch-off" })).toThrow(
      "Worktree options require --isolation worktree",
    );
  });

  it("rejects unknown isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "container" })).toThrow(
      "Unsupported workspace isolation",
    );
  });

  it("warns about a duplicate project only when --project did not choose it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-create-alias-"));
    try {
      const real = path.join(root, "real");
      const alias = path.join(root, "alias");
      mkdirSync(real);
      symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
      const projects = [
        {
          projectId: "prj_alias",
          projectDisplayName: "alias",
          projectRootPath: alias,
          projectKind: "git" as const,
        },
        {
          projectId: "prj_real",
          projectDisplayName: "real",
          projectRootPath: real,
          projectKind: "git" as const,
        },
      ];
      listProjects.mockResolvedValue({ projects } as never);
      createWorkspace.mockResolvedValue({
        workspace: {
          id: "ws-twin",
          projectId: "prj_real",
          projectDisplayName: "real",
          name: "twin",
          workspaceDirectory: real,
          workspaceKind: "local_checkout",
          notifications: "on" as const,
        },
      } as never);
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const target = { kind: "instance", home: "/tmp/workspace-create-test" } as const;

      await runCreateCommand({ daemonTarget: target, isolation: "local", path: real }, {} as never);
      expect(stderr).toHaveBeenCalledOnce();
      expect(String(stderr.mock.calls[0]![0])).toContain("was created in project prj_real");

      stderr.mockClear();
      await runCreateCommand(
        { daemonTarget: target, isolation: "local", path: real, project: "prj_real" },
        {} as never,
      );
      expect(stderr).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      stderr.mockRestore();
      stdout.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
      listProjects.mockReset();
      listProjects.mockResolvedValue({ projects: [] });
      createWorkspace.mockReset();
    }
  });
});
