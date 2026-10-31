import type { AgentScreenReadySyncState } from "@/hooks/use-agent-screen-state-machine";

// Whether the open chat can be read yet, for agents testing the app without sleeps.
// docs/agent-testing.md#waiting-for-the-app describes the marker and log line built on it.
export type TimelineReadiness = "loading" | "running" | "settled" | "error";

export function resolveTimelineReadiness(input: {
  sync: AgentScreenReadySyncState["status"];
  isTurnActive: boolean;
}): TimelineReadiness {
  if (input.sync === "sync_error") return "error";
  // A reconnect or catch-up can still replace what the chat shows.
  if (input.sync === "catching_up" || input.sync === "reconnecting") return "loading";
  return input.isTurnActive ? "running" : "settled";
}

// Closed turns per chat for the life of the app process. A waiter reads the count, sends, then
// waits for "settled" with a larger count, so a turn that ends between two polls is not missed.
const closedTurns = new Map<string, number>();
const listeners = new Set<() => void>();

export function closedTurnsKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function readClosedTurns(key: string): number {
  return closedTurns.get(key) ?? 0;
}

/** Counts every end of a turn: completion, error, cancel, or a send that never opened one. */
export function recordTurnActivity(key: string, wasActive: boolean, isActive: boolean): void {
  if (!wasActive || isActive) return;
  closedTurns.set(key, readClosedTurns(key) + 1);
  for (const listener of listeners) listener();
}

// One store subscription per chat however many panes show it, so a turn counts once.
const counters = new Map<string, { refs: number; stop: () => void }>();

export function retainTurnCounter(key: string, start: () => () => void): () => void {
  const counter = counters.get(key);
  if (counter) counter.refs += 1;
  else counters.set(key, { refs: 1, stop: start() });
  return () => {
    const current = counters.get(key);
    if (!current) return;
    current.refs -= 1;
    if (current.refs > 0) return;
    current.stop();
    counters.delete(key);
  };
}

export function subscribeClosedTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
