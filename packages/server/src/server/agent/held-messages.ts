import type { Logger } from "pino";
import type { AgentManager, AgentManagerEvent } from "./agent-manager.js";

/**
 * "deferred": a steer the provider could not take; stopping the turn it waits behind discards it,
 * as Stop does to a steer Claude has queued but not read.
 * "queued": waits for the agent to go idle and survives Stop.
 */
export type HeldMessageKind = "deferred" | "queued";
export type HeldMessageOutcome = "dispatched" | "discarded";

/** A dispatch either settled (started or steered into a turn) or met a turn it cannot steer into. */
export type HeldDispatchResult = { kind: "settled" } | { kind: "busy"; turnId: string };

export type HeldMessageController = Pick<AgentManager, "getAgent" | "hasInFlightRun" | "subscribe">;

export interface HoldMessageParams {
  kind: HeldMessageKind;
  /** The turn this message waits behind. */
  turnId: string | null;
  messageId?: string;
  dispatch: () => Promise<HeldDispatchResult>;
}

interface HeldMessage extends HoldMessageParams {
  /** A deferred message leaves only after its turn ends without being canceled. */
  turnEnded: boolean;
  settle: (outcome: HeldMessageOutcome) => void;
  outcome: Promise<HeldMessageOutcome>;
}

/**
 * Messages held for one agent, released in order one at a time: a queued message once the agent
 * has no turn of any kind, a deferred steer once its turn ends. A released message settles only after its dispatch has registered a run or steered, so a
 * wait on it never sees the gap before the run starts. A direct steer the provider accepts still
 * goes ahead of held messages; the order covers held messages only.
 */
class AgentHeldMessages {
  private readonly entries: HeldMessage[] = [];
  private dispatching = false;
  /** Turns that ended while messages were held, so a head retargeted at one too late still sees it. */
  private readonly endedTurns = new Map<string, "completed" | "canceled">();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly manager: HeldMessageController,
    private readonly agentId: string,
    private readonly logger: Logger,
    private readonly onEmpty: () => void,
  ) {}

  hold(params: HoldMessageParams): Promise<HeldMessageOutcome> {
    let settle!: (outcome: HeldMessageOutcome) => void;
    const outcome = new Promise<HeldMessageOutcome>((resolve) => {
      settle = resolve;
    });
    // The turn may have ended while the provider was declining the steer.
    this.entries.push({ ...params, turnEnded: !this.isTurnActive(params.turnId), settle, outcome });
    this.unsubscribe ??= this.manager.subscribe((event) => this.handleEvent(event), {
      agentId: this.agentId,
      includeInternal: true,
      replayState: false,
    });
    this.logger.info(
      {
        agentId: this.agentId,
        kind: params.kind,
        turnId: params.turnId,
        held: this.entries.length,
      },
      "agent.held_message.held",
    );
    this.pump();
    return outcome;
  }

  outcomeOf(messageId: string): Promise<HeldMessageOutcome> | null {
    return this.entries.find((entry) => entry.messageId === messageId)?.outcome ?? null;
  }

  private handleEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_stream") {
      if (event.agentId !== this.agentId) return;
      const turnEvent = event.event;
      if (turnEvent.type === "turn_canceled") {
        if (turnEvent.turnId) this.endedTurns.set(turnEvent.turnId, "canceled");
        // An interrupting send cancels the turn too: deferred steers aimed at it go, queued stay.
        this.discard(
          (entry) => entry.kind === "deferred" && entry.turnId === turnEvent.turnId,
          "turn_canceled",
        );
      } else if (turnEvent.type === "turn_completed" || turnEvent.type === "turn_failed") {
        if (turnEvent.turnId) this.endedTurns.set(turnEvent.turnId, "completed");
        for (const entry of this.entries) {
          if (entry.turnId === turnEvent.turnId) entry.turnEnded = true;
        }
      }
    } else if (event.type !== "agent_state" || event.agent.id !== this.agentId) {
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (this.dispatching) return;
    const agent = this.manager.getAgent(this.agentId);
    if (!agent || agent.lifecycle === "closed") {
      this.discard(() => true, "agent_closed");
      return;
    }
    const head = this.entries[0];
    if (!head) {
      this.dispose();
      return;
    }
    if (head.kind === "deferred" && !head.turnEnded) return;
    // A permission can outlive its turn; a queued message waits for it to be answered.
    if (head.kind === "queued" && agent.pendingPermissions.size > 0) return;
    if (this.manager.hasInFlightRun(this.agentId) || agent.activeTurnId) {
      // A deferred steer whose turn ended tries the turn that followed it; a queued message waits
      // for idle. Neither dispatches while a run has started but has no turn to steer into yet.
      const steerable = Boolean(agent.activeForegroundTurnId ?? agent.activeTurnId);
      if (head.kind === "queued" || !steerable) return;
    }

    this.dispatching = true;
    void this.dispatchHead(head).finally(() => {
      this.dispatching = false;
      this.pump();
    });
  }

  private async dispatchHead(head: HeldMessage): Promise<void> {
    let result: HeldDispatchResult;
    try {
      result = await head.dispatch();
    } catch (error) {
      this.logger.error({ err: error, agentId: this.agentId }, "Failed to deliver held message");
      this.remove(head, "discarded");
      return;
    }
    if (result.kind === "settled") {
      this.remove(head, "dispatched");
      return;
    }
    // Another turn took the agent first; stay at the head, now behind that turn.
    head.turnId = result.turnId;
    const ended = this.endedTurns.get(result.turnId);
    if (ended === "canceled" && head.kind === "deferred") {
      this.remove(head, "discarded");
    } else {
      head.turnEnded = ended !== undefined || !this.isTurnActive(result.turnId);
    }
  }

  private isTurnActive(turnId: string | null): boolean {
    const agent = this.manager.getAgent(this.agentId);
    return agent?.activeTurnId === turnId || agent?.activeForegroundTurnId === turnId;
  }

  private discard(predicate: (entry: HeldMessage) => boolean, reason: string): void {
    for (const entry of this.entries.filter(predicate)) {
      this.logger.info(
        { agentId: this.agentId, kind: entry.kind, turnId: entry.turnId, reason },
        "agent.held_message.discarded",
      );
      this.remove(entry, "discarded");
    }
    if (this.entries.length === 0 && !this.dispatching) this.dispose();
  }

  private remove(entry: HeldMessage, outcome: HeldMessageOutcome): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) this.entries.splice(index, 1);
    entry.settle(outcome);
  }

  private dispose(): void {
    this.endedTurns.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onEmpty();
  }
}

const heldByManager = new WeakMap<object, Map<string, AgentHeldMessages>>();

function agentsFor(manager: HeldMessageController): Map<string, AgentHeldMessages> {
  let agents = heldByManager.get(manager);
  if (!agents) {
    agents = new Map();
    heldByManager.set(manager, agents);
  }
  return agents;
}

export function holdMessage(
  manager: HeldMessageController,
  agentId: string,
  params: HoldMessageParams,
  logger: Logger,
): Promise<HeldMessageOutcome> {
  const agents = agentsFor(manager);
  let held = agents.get(agentId);
  if (!held) {
    const created = new AgentHeldMessages(manager, agentId, logger, () => {
      if (agents.get(agentId) === created) agents.delete(agentId);
    });
    agents.set(agentId, created);
    held = created;
  }
  return held.hold(params);
}

/** Resolves once a held message is dispatched or discarded; null when it is not held. */
export function waitForHeldMessage(
  manager: HeldMessageController,
  agentId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<HeldMessageOutcome> | null {
  const outcome = agentsFor(manager).get(agentId)?.outcomeOf(messageId);
  if (!outcome || !signal) return outcome ?? null;
  return raceAbort(outcome, signal);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("wait for held message aborted", "AbortError"));
  });
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function hasHeldMessages(manager: HeldMessageController, agentId: string): boolean {
  return agentsFor(manager).has(agentId);
}
