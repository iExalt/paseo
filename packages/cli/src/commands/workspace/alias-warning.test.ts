import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warnAboutAliasedProject } from "./alias-warning.js";

const local = { kind: "instance", home: "/tmp/paseo-home" } as const;

function project(projectId: string, projectRootPath: string) {
  return {
    projectId,
    projectDisplayName: path.basename(projectRootPath),
    projectRootPath,
    projectKind: "git" as const,
  };
}

describe("warnAboutAliasedProject", () => {
  let root: string;
  let real: string;
  let alias: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "paseo-alias-warning-"));
    real = path.join(root, "real");
    alias = path.join(root, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(projects: ReturnType<typeof project>[], projectId: string, target = local) {
    const warn = vi.fn();
    await warnAboutAliasedProject({
      client: { listProjects: async () => ({ projects }) },
      daemonTarget: target,
      workspaceId: "wks_new",
      projectId,
      warn,
    });
    return warn;
  }

  it("names the new workspace and the existing project when the checkout is shared", async () => {
    const warn = await run([project("prj_old", alias), project("prj_new", real)], "prj_new");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe(
      `Warning: workspace wks_new was created in project prj_new (${real}), which is the same ` +
        `checkout as project prj_old (${alias}). To use the existing project, archive this ` +
        "workspace and recreate it with `workspace create --project prj_old`.",
    );
  });

  it("stays silent for different checkouts, a sole project, and missing paths", async () => {
    const other = path.join(root, "other");
    mkdirSync(other);
    expect(
      await run([project("prj_a", other), project("prj_b", real)], "prj_b"),
    ).not.toHaveBeenCalled();
    expect(await run([project("prj_b", real)], "prj_b")).not.toHaveBeenCalled();
    const gone = path.join(root, "gone");
    expect(
      await run([project("prj_a", gone), project("prj_b", path.join(root, "gone2"))], "prj_b"),
    ).not.toHaveBeenCalled();
  });

  it("stays silent for a remote daemon and when listing fails", async () => {
    const projects = [project("prj_old", alias), project("prj_new", real)];
    expect(
      await run(projects, "prj_new", {
        kind: "endpoint",
        host: "remote:6767",
      } as never),
    ).not.toHaveBeenCalled();

    const warn = vi.fn();
    await warnAboutAliasedProject({
      client: {
        listProjects: async () => {
          throw new Error("offline");
        },
      },
      daemonTarget: local,
      workspaceId: "wks_new",
      projectId: "prj_new",
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
