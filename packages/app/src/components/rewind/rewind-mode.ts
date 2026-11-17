import { TimelineRequestSupersededError } from "@/timeline/timeline-request";
import type { RewindMode } from "./use-rewind-capabilities";

export function shouldRestoreComposerForRewindMode(mode: RewindMode): boolean {
  return mode === "conversation" || mode === "both";
}

/**
 * Once the daemon accepts a conversation rewind, the rewound message exists only in
 * `rewoundText`, so the composer gets it back even when the timeline refresh fails.
 * The rewind's own timeline reset starts a newer request that supersedes the refresh;
 * that newer request delivers the rewound timeline, so supersession is not an error.
 */
export async function runRewind(input: {
  mode: RewindMode;
  rewind: () => Promise<void>;
  refreshTimeline: () => Promise<unknown>;
  restoreComposer: () => void;
}): Promise<void> {
  await input.rewind();
  if (!shouldRestoreComposerForRewindMode(input.mode)) return;
  try {
    await input.refreshTimeline();
  } catch (error) {
    if (!(error instanceof TimelineRequestSupersededError)) throw error;
  } finally {
    input.restoreComposer();
  }
}
