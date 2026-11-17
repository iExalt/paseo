import { TimelineRequestSupersededError } from "@/timeline/timeline-request";
import type { RewindMode } from "./use-rewind-capabilities";

export function shouldRestoreComposerForRewindMode(mode: RewindMode): boolean {
  return mode === "conversation" || mode === "both";
}

/**
 * Owned-subscription daemons send `agent.timeline.replacement` to every modern client,
 * the rewinding one included.
 */
export function daemonSendsRewindReplacement(
  features: { ownedSubscriptions?: boolean } | null | undefined,
): boolean {
  return features?.ownedSubscriptions === true;
}

/**
 * Once the daemon accepts a conversation rewind, the rewound message exists only in
 * `rewoundText`, so the composer gets it back even when the timeline refresh fails.
 * Omit `refreshTimeline` when the daemon pushes `agent.timeline.replacement` to the
 * rewinding client; its handler fetches the rewound timeline. A superseded refresh
 * lost a race with that fetch, which delivers the same timeline, so it is not an error.
 */
export async function runRewind(input: {
  mode: RewindMode;
  rewind: () => Promise<void>;
  refreshTimeline?: () => Promise<unknown>;
  restoreComposer: () => void;
}): Promise<void> {
  await input.rewind();
  if (!shouldRestoreComposerForRewindMode(input.mode)) return;
  try {
    await input.refreshTimeline?.();
  } catch (error) {
    if (!(error instanceof TimelineRequestSupersededError)) throw error;
  } finally {
    input.restoreComposer();
  }
}
