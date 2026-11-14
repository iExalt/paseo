import { createProjectViewKey, type WorkspaceStructureProject } from "./workspace-structure";

type OrderProject = Pick<WorkspaceStructureProject, "viewKey" | "hosts"> & {
  projectKey?: string | null;
};

/** Follow a project's stable placements when directory grouping changes its view key. */
export function resolveProjectOrder(
  projects: readonly OrderProject[],
  storedOrder: readonly string[],
): string[] {
  const currentKeys = new Set(projects.map((project) => project.viewKey));
  const explicitKeys = new Set(storedOrder.filter((key) => currentKeys.has(key)));
  const aliases = new Map<string, Set<string>>();
  for (const project of projects) {
    const keys = project.hosts.map((host) =>
      createProjectViewKey({
        kind: "placement",
        serverId: host.serverId,
        projectId: host.projectId,
      }),
    );
    if (project.projectKey) keys.push(project.projectKey);
    for (const key of keys) {
      const targets = aliases.get(key) ?? new Set<string>();
      targets.add(project.viewKey);
      aliases.set(key, targets);
    }
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const key of storedOrder) {
    // An exact saved position wins over an obsolete alias, including keys now shared by hosts.
    const targets = currentKeys.has(key) ? [key] : aliases.get(key);
    if (!targets) {
      if (!seen.has(key)) resolved.push(key);
      seen.add(key);
      continue;
    }
    for (const target of targets) {
      if (seen.has(target) || (target !== key && explicitKeys.has(target))) continue;
      resolved.push(target);
      seen.add(target);
    }
  }
  return resolved;
}
