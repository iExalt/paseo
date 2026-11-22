import type { LocalAgentStore } from "@cursor/sdk";
import { cursorUnresolvedSteerMessage, interruptedCursorRunMessage } from "./cursor-sdk-history.js";
import type { CursorTurnJournal } from "./cursor-sdk-turn-journal.js";

/** Check for an unjoined execution before opening a replacement SDK runtime. */
export async function assertCursorRunReleased(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  agentId: string,
  cwd: string,
): Promise<void> {
  const agent = await store.agents.get({ agentId });
  if (!agent || agent.cwd !== cwd) {
    throw new Error("Cursor SDK can only resume its saved local agent and workspace.");
  }
  // SDK cancel clears activeRunId before its controller and tools have joined.
  const interrupted = (await journal.read()).find((turn) => turn.nativeRunId && !turn.joined);
  if (interrupted?.nativeRunId) {
    throw new Error(
      interrupted.unresolvedNativeFollowUp
        ? cursorUnresolvedSteerMessage()
        : interruptedCursorRunMessage(interrupted.followUpIds?.at(-1) ?? interrupted.nativeRunId),
    );
  }
  if (!agent.activeRunId) return;
  const run = await store.runs.get({ agentId, runId: agent.activeRunId });
  const unusedFirstReservation =
    run?.status === "queued" &&
    run.turnNumber === 1 &&
    run.startedAt == null &&
    !agent.latestCheckpoint;
  if (!run || run.status === "running" || (run.status === "queued" && !unusedFirstReservation)) {
    // A detached run offers no attestation that the SDK writer and tool process
    // are gone. Static SDK cancellation changes metadata and cannot stop them.
    throw new Error(interruptedCursorRunMessage(agent.activeRunId));
  }
}
