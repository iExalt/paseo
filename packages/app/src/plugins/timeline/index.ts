import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";
import { transformTimelineItem, type TimelineItemTransform } from "./model";

export type { InstalledPluginTimelineItem, TimelineItemTransform } from "./model";
export { PluginTimelineItemView } from "./view";

// One transform per registry snapshot and host. The projection cache is keyed by the transform's
// identity, so a transform per chat view made every freshly mounted chat reproject, and deep-clone,
// its whole history. Without any timeline transformer there is nothing to project at all.
const transformsBySnapshot = new WeakMap<
  InstalledPlugin[],
  Map<string, TimelineItemTransform | undefined>
>();

function resolveTimelineTransform(
  installed: InstalledPlugin[],
  serverId: string,
): TimelineItemTransform | undefined {
  let byServer = transformsBySnapshot.get(installed);
  if (!byServer) {
    byServer = new Map();
    transformsBySnapshot.set(installed, byServer);
  }
  if (byServer.has(serverId)) return byServer.get(serverId);
  const plugins = installed.filter(
    (plugin) => plugin.serverId === serverId && plugin.timelineTransformers.length > 0,
  );
  const transform: TimelineItemTransform | undefined =
    plugins.length > 0 ? (input) => transformTimelineItem({ ...input, plugins }) : undefined;
  byServer.set(serverId, transform);
  return transform;
}

export function useInstalledTimelineTransform(serverId: string): TimelineItemTransform | undefined {
  return resolveTimelineTransform(useInstalledPlugins(), serverId);
}
