import type { LocalAgentRunDocument, LocalAgentStore } from "@cursor/sdk";
import {
  forgetReleasedExecutionOwner,
  inspectExecutionOwner,
} from "../execution-owner/execution-owner.js";
import { cursorUnresolvedSteerMessage, interruptedCursorRunMessage } from "./cursor-sdk-history.js";
import type { CursorHistoryTurn, CursorTurnJournal } from "./cursor-sdk-turn-journal.js";

import { waitForExecutionOwner } from "../execution-owner/owned-process.js";
import { rm } from "node:fs/promises";
import { assessProcessLedger } from "./cursor-sdk-process-ledger.js";

export type OwnerTerminalProof = "recovery" | "domain-released" | "completed-writer";

const interrupted = {
  status: "error",
  message:
    "The previous Cursor SDK run was interrupted when Paseo disconnected. Its saved output is available in this chat.",
  code: "cursor_sdk_run_interrupted",
} as const;

function ownerBlocked(turn: CursorHistoryTurn, reason: string): Error {
  const run = turn.executionRunIds?.at(-1) ?? turn.nativeRunId ?? turn.id;
  return new Error(
    `Cursor SDK run ${run} ${reason} Resume this chat once its previous tools have stopped and Paseo can confirm ownership.`,
  );
}

async function assertOwnerReleased(turn: CursorHistoryTurn): Promise<void> {
  if (!turn.executionOwner) throw ownerBlocked(turn, "has no recorded execution owner.");
  const observed = await inspectExecutionOwner(turn.executionOwner);
  if (observed === "running") {
    throw ownerBlocked(turn, "has no release receipt and its tools could still be running.");
  }
  if (observed !== "released")
    throw ownerBlocked(turn, "has no confirmed execution-owner shutdown.");
}

async function reconcileNativeRows(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  agentId: string,
  turn: CursorHistoryTurn,
  recovered: boolean,
  runIds = new Set([
    ...(turn.executionRunIds ?? []),
    ...(turn.nativeRunId ? [turn.nativeRunId] : []),
  ]),
): Promise<void> {
  const agent = await store.agents.get({ agentId });
  if (!agent || (agent.activeRunId && !runIds.has(agent.activeRunId))) {
    throw ownerBlocked(turn, "no longer matches the agent's active run.");
  }
  const runs: LocalAgentRunDocument[] = [];
  for (const runId of runIds) {
    const run = await store.runs.get({ agentId, runId });
    if (run) runs.push(run);
  }
  const last = runs.at(-1);
  turn.terminal ??= recoveredTerminal(last);
  if (recovered) turn.recovered = true;
  // Keep the terminal intent across a crash between the row and pointer updates.
  await journal.save(turn);
  for (const run of runs) {
    await terminalizeNativeRun(store, run, run === last && !recovered ? turn.terminal : undefined);
  }
  const latest = await store.agents.get({ agentId });
  if (!latest) throw ownerBlocked(turn, "no longer has a saved agent.");
  if (latest.activeRunId && !runIds.has(latest.activeRunId)) {
    throw ownerBlocked(turn, "has a different active writer.");
  }
  if (latest.activeRunId || latest.status === "running") {
    await store.agents.update({
      agent: {
        ...latest,
        activeRunId: null,
        status: latest.status === "running" ? "idle" : latest.status,
        updatedAt: Date.now(),
      },
    });
  }
}

async function terminalizeNativeRun(
  store: LocalAgentStore,
  run: LocalAgentRunDocument,
  terminal: CursorHistoryTurn["terminal"],
): Promise<void> {
  if (run.status !== "queued" && run.status !== "running") return;
  const now = Date.now();
  await store.runs.update({
    run: {
      ...run,
      status: terminal?.status ?? "cancelled",
      ...(terminal?.status === "finished" ? { result: terminal.fallback ?? run.result } : {}),
      ...(terminal?.status === "error" ? { error: terminal.message } : {}),
      endedAt: now,
      updatedAt: now,
    },
  });
}

export async function reconcileReleasedTurn(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  agentId: string,
  turn: CursorHistoryTurn,
  proof: OwnerTerminalProof = "recovery",
): Promise<void> {
  const owner = turn.executionOwner;
  if (!owner) throw ownerBlocked(turn, "has no recorded execution owner.");
  // The live controller already joined this exact owner. Only a replacement
  // daemon needs to attest release again.
  if (proof === "recovery") await assertOwnerReleased(turn);
  await reconcileNativeRows(store, journal, agentId, turn, proof === "recovery");
  const allowBackground = proof === "completed-writer" && !turn.ownerStopPending;
  if (proof === "completed-writer" && !allowBackground) await waitForExecutionOwner(owner);
  turn.ownerStopPending = false;
  turn.joined = true;
  await journal.save(turn);
  if (proof !== "completed-writer") {
    await forgetReleasedExecutionOwner(owner).catch(() => undefined);
  }
}

function recoveredTerminal(run: LocalAgentRunDocument | undefined): CursorHistoryTurn["terminal"] {
  switch (run?.status) {
    case "finished":
      return { status: "finished", fallback: run.result ?? undefined };
    case "cancelled":
      return { status: "cancelled" };
    case "error":
      return { status: "error", message: run.error ?? "Cursor SDK run failed." };
    default:
      return interrupted;
  }
}

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
  for (const turn of await journal.read()) {
    if (turn.joined && !turn.ownerStopPending) continue;
    if (turn.executionOwner) {
      await reconcileReleasedTurn(store, journal, agentId, turn);
    } else if (turn.nativeRunId) {
      if (await recoverCrashedTurn(store, journal, agentId, turn)) continue;
      throw new Error(
        turn.unresolvedNativeFollowUp
          ? cursorUnresolvedSteerMessage()
          : interruptedCursorRunMessage(turn.followUpIds?.at(-1) ?? turn.nativeRunId),
      );
    } else if (turn.executionIntent) {
      // A launcher from the dead daemon has no live admission pipe. It never
      // received SDK options and cannot start a writer, even if its start is late.
      turn.terminal ??= interrupted;
      turn.joined = true;
      await journal.save(turn);
    }
  }
  await assertNativeRunReleased(store, agentId);
}

/**
 * A turn without an execution owner ran its shells inside the daemon that
 * crashed. Close it as interrupted once its process ledger shows that daemon
 * and every shell it recorded are gone.
 */
async function recoverCrashedTurn(
  store: LocalAgentStore,
  journal: CursorTurnJournal,
  agentId: string,
  turn: CursorHistoryTurn,
): Promise<boolean> {
  // Paseo never learned which run the follow-up started, so it cannot close it.
  if (turn.unresolvedNativeFollowUp || !turn.nativeRunId) return false;
  const ledger = journal.processLedgerPath(turn.id);
  if (!(await assessProcessLedger(ledger)).released) return false;
  const runIds = new Set([turn.nativeRunId, ...(turn.followUpIds ?? [])]);
  await reconcileNativeRows(store, journal, agentId, turn, true, runIds);
  turn.joined = true;
  await journal.save(turn);
  await rm(ledger, { force: true });
  return true;
}

async function assertNativeRunReleased(store: LocalAgentStore, agentId: string): Promise<void> {
  const current = await store.agents.get({ agentId });
  if (!current?.activeRunId) return;
  const run = await store.runs.get({ agentId, runId: current.activeRunId });
  const unusedFirstReservation =
    run?.status === "queued" &&
    run.turnNumber === 1 &&
    run.startedAt == null &&
    !current.latestCheckpoint;
  if (!run || run.status === "running" || (run.status === "queued" && !unusedFirstReservation)) {
    // A detached, unenrolled run offers no attestation that the SDK writer and
    // its tools are gone. Static SDK cancellation changes metadata only.
    throw new Error(interruptedCursorRunMessage(current.activeRunId));
  }
}
