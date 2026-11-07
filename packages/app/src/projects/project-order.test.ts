import { describe, expect, it } from "vitest";
import type { ProjectDescriptor } from "@/stores/session-store";
import { composeWorkspaceStructure } from "@/stores/session-store-hooks/selectors";
import {
  buildSidebarProjectsFromStructure,
  computeSidebarOrderUpdates,
} from "@/hooks/sidebar-workspaces-view-model";
import { buildWorkspaceStructureProjects, createProjectViewKey } from "./workspace-structure";

const sharedKey = "remote:example.test/team/repo";
const otherKey = "remote:example.test/team/other";
const placement = (projectId: string) =>
  createProjectViewKey({ kind: "placement", serverId: "host", projectId });

function project(projectId: string, projectKey: string, name: string): ProjectDescriptor {
  return {
    projectId,
    projectKey,
    projectDisplayName: name,
    projectCustomName: null,
    projectCustomIconRevision: null,
    projectRootPath: `/repos/${projectId}`,
    projectKind: "git",
  };
}

const other = project("other", otherKey, "A other");
const first = project("first", sharedKey, "Z first");
const second = project("second", sharedKey, "Z second");

function reload(order: string[], projects: ProjectDescriptor[]) {
  const structure = composeWorkspaceStructure({
    projects: buildWorkspaceStructureProjects({
      sessions: [{ serverId: "host", projects, workspaces: [] }],
    }),
    projectOrder: order,
  });
  const updates = computeSidebarOrderUpdates({
    projects: buildSidebarProjectsFromStructure(structure),
    persistedProjectOrder: order,
  });
  return {
    displayed: structure.projects.map((entry) => entry.viewKey),
    saved: updates.projectOrder ?? order,
    update: updates.projectOrder,
  };
}

describe("sidebar project order across directory identity changes", () => {
  it("retains a duplicate checkout's position when it becomes the unique shared project", () => {
    const saved = [placement("first"), otherKey, placement("second")];
    expect(reload(saved, [first, other, second]).displayed).toEqual(saved);

    const restored = reload(saved, [first, other]);
    expect(restored.displayed).toEqual([sharedKey, otherKey]);
    expect(restored.saved).toEqual([sharedKey, otherKey, placement("second")]);
    expect(reload(restored.saved, [first, other]).update).toBeNull();
    expect(saved).toEqual([placement("first"), otherKey, placement("second")]);
  });

  it("keeps split checkouts together at the former shared project's position", () => {
    const restored = reload([sharedKey, otherKey], [first, other, second]);
    expect(restored.displayed).toEqual([placement("first"), placement("second"), otherKey]);
    expect(restored.saved).toEqual(restored.displayed);
    expect(reload(restored.saved, [first, other, second]).update).toBeNull();
  });

  it("honors an explicit current-key position instead of an obsolete alias", () => {
    const restored = reload([placement("first"), otherKey, sharedKey], [first, other]);
    expect(restored.displayed).toEqual([otherKey, sharedKey]);
    expect(restored.saved).toEqual([otherKey, sharedKey]);
  });

  it("preserves offline projects and exact whitespace identities", () => {
    const offline = "offline project ";
    const spaced = project("spaced", "project ", "B spaced");
    const restored = reload([offline, placement("first"), "project "], [first, spaced]);
    expect(restored.displayed).toEqual([sharedKey, "project "]);
    expect(restored.saved).toEqual([offline, sharedKey, "project "]);
  });

  it("uses a still-visible shared key for its exact project when other checkouts split", () => {
    const projects = buildWorkspaceStructureProjects({
      sessions: [
        { serverId: "host", projects: [first, other, second], workspaces: [] },
        { serverId: "other-host", projects: [first], workspaces: [] },
      ],
    });
    const restored = composeWorkspaceStructure({ projects, projectOrder: [sharedKey, otherKey] });
    expect(restored.projects.map((entry) => entry.viewKey)).toEqual([
      sharedKey,
      placement("first"),
      otherKey,
      placement("second"),
    ]);
  });
});
