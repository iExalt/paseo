import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type TimelineResponseGuard = (
  page?: Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>,
) => boolean;

/** The response belongs to a replaced connection, timeline, or catch-up request. */
export class TimelineRequestSupersededError extends Error {
  constructor() {
    super("Timeline request was superseded; retry against the current timeline.");
    this.name = "TimelineRequestSupersededError";
  }
}
