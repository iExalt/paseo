import { cursorSkillReferences } from "../prompt-attachments.js";
import { randomUUID } from "node:crypto";
import type { Run, RunResult, SDKUserMessage } from "@cursor/sdk";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import type {
  AgentPromptInput,
  AgentRunResult,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  SteerActiveTurnOptions,
  SteerResult,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  forgetReleasedExecutionOwner,
  type ExecutionOwner,
} from "../execution-owner/execution-owner.js";
import { waitForExecutionOwner } from "../execution-owner/owned-process.js";
import { CURSOR_SDK_PROVIDER as PROVIDER } from "./cursor-sdk-auth.js";
import { cursorUnresolvedSteerMessage, streamItems, terminalTools } from "./cursor-sdk-history.js";
import type { OwnerTerminalProof } from "./cursor-sdk-recovery.js";
import { CursorToolProcesses } from "./cursor-sdk-tool-processes.js";
import type { CursorHistoryTurn, CursorTurnJournal } from "./cursor-sdk-turn-journal.js";

const OPERATION_DEADLINE_MS = 1_500;

export interface CursorTurnExecution {
  prepareOwner: (generation: string) => Promise<void>;
  discardUnadmittedOwner: () => Promise<void>;
  enroll: (owner: ExecutionOwner) => Promise<void>;
  bindRun: (nativeRunId: string) => Promise<void>;
  attachFinish: (finish: (waitForTools: boolean, cancelTools: boolean) => Promise<void>) => void;
}

type NativeSend = (
  input: SDKUserMessage,
  bind: (nativeRunId: string) => Promise<void>,
  throwIfStopped: () => void,
  execution: CursorTurnExecution,
) => Promise<Run>;

interface CursorTurn {
  record: CursorHistoryTurn;
  native: Promise<Run>;
  completion: Promise<AgentRunResult>;
  toolProcesses: CursorToolProcesses;
  finishExecution?: (waitForTools: boolean, cancelTools: boolean) => Promise<void>;
  completedWriter?: boolean;
  nativeStopConfirmed?: boolean;
  sdkWriterFinished?: boolean;
  nativeStopRejected?: boolean;
  stop?: Promise<void>;
  steer?: Promise<SteerResult>;
  followUp?: Run;
  cancellations: Map<Run, Promise<void>>;
  current?: Run;
  emitted: number;
  stopRequested: boolean;
}

function withDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), OPERATION_DEADLINE_MS);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

export class CursorRunController {
  private active?: CursorTurn;

  constructor(
    private readonly sessionId: string,
    private readonly journal: CursorTurnJournal,
    private readonly emit: (event: AgentStreamEvent) => void,
    private readonly mapUsage: (usage: RunResult["usage"]) => AgentUsage | undefined,
    private readonly reconcileOwnedTerminal?: (
      turn: CursorHistoryTurn,
      proof: OwnerTerminalProof,
    ) => Promise<void>,
  ) {}

  async start(
    prompt: AgentPromptInput,
    input: SDKUserMessage,
    send: NativeSend,
    clientMessageId?: string,
    text = displayText(prompt),
  ): Promise<{ turnId: string; completion: Promise<AgentRunResult> }> {
    if (this.active) throw new Error("Cursor SDK is still running or stopping its current turn.");
    const id = randomUUID();
    const cursorSkills = cursorSkillReferences(typeof prompt === "string" ? undefined : prompt);
    const record: CursorHistoryTurn = {
      id,
      user: {
        type: "user_message",
        messageId: clientMessageId ?? `${id}:user`,
        ...(clientMessageId ? { clientMessageId } : {}),
        text,
        ...(cursorSkills.length ? { cursorSkills } : {}),
      },
      createdAt: new Date().toISOString(),
      steers: [],
    };
    const toolProcesses = new CursorToolProcesses();
    const execution: CursorTurnExecution = {
      prepareOwner: async (generation) => {
        record.executionIntent = generation;
        await this.journal.enrollExecutionOwner(record);
      },
      discardUnadmittedOwner: async () => {
        if (record.executionOwner) throw new Error("Cannot discard an enrolled execution owner.");
        delete record.executionIntent;
        await this.journal.save(record);
      },
      enroll: async (owner) => {
        if (record.executionOwner)
          throw new Error("Cursor SDK turn already has an execution owner.");
        record.executionOwner = owner;
        await this.journal.enrollExecutionOwner(record);
      },
      bindRun: async (nativeRunId) => {
        if (!record.executionOwner)
          throw new Error("Cursor SDK turn has no enrolled execution owner.");
        record.executionRunIds ??= [];
        if (record.executionRunIds.includes(nativeRunId)) return;
        record.nativeRunId ??= nativeRunId;
        record.executionRunIds.push(nativeRunId);
        await this.journal.save(record);
      },
      attachFinish: (finish) => {
        turn.finishExecution = finish;
      },
    };
    const native = Promise.resolve().then(async () => {
      await this.journal.admit(record, prompt);
      return toolProcesses.scope(() =>
        send(
          input,
          async (nativeRunId) => {
            if (record.nativeRunId === nativeRunId) return;
            if (record.nativeRunId) throw new Error("Cursor SDK changed the admitted run ID.");
            record.nativeRunId = nativeRunId;
            await this.journal.save(record);
          },
          () => {
            if (turn.stopRequested) throw new Error("Cursor SDK turn stopped before dispatch.");
          },
          execution,
        ),
      );
    });
    const turn: CursorTurn = {
      record,
      native,
      completion: Promise.resolve().then(() => this.consume(turn)),
      toolProcesses,
      emitted: 0,
      cancellations: new Map(),
      stopRequested: false,
    };
    this.active = turn;
    void turn.completion.catch(() => {});
    // AgentManager's accepted turn must mean the SDK actually admitted the send.
    await native;
    return { turnId: id, completion: turn.completion };
  }

  async steer(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult> {
    const turn = this.active;
    if (!turn || turn.record.id !== options.expectedTurnId || turn.stopRequested || turn.steer) {
      return { status: "unavailable" };
    }
    // Native steering takes text only. The full input can be sent once the run ends.
    if (
      typeof prompt !== "string" &&
      prompt.some((block) => block.type !== "text" || "mimeType" in block)
    ) {
      return { status: "unavailable" };
    }
    const run = turn.current;
    const text = displayText(prompt);
    const steer = run?.steer?.bind(run);
    if (!run || run.status !== "running" || !steer || !text) return { status: "unavailable" };

    const id = options.clientMessageId ?? `${turn.record.id}:steer:${randomUUID()}`;
    const after = turn.emitted;
    const user = {
      type: "user_message" as const,
      text,
      messageId: id,
      ...(options.clientMessageId ? { clientMessageId: id } : {}),
    };
    let locallyReported = false;
    const operation = (async (): Promise<SteerResult> => {
      await this.journal.saveInput(turn.record.id, id, prompt);
      if (turn.stopRequested || run.status !== "running") return { status: "unavailable" };
      const outcome = await steer(text);
      if (outcome === "revert_to_followup") {
        if (turn.stopRequested || (run.status as Run["status"]) === "cancelled") {
          throw new Error("Cursor SDK canceled the turn before steering could be delivered.");
        }
        return { status: "unavailable" };
      }
      if (typeof outcome === "object") {
        if (outcome.run && outcome.run.id !== run.id) {
          turn.followUp = outcome.run;
          (turn.record.followUpIds ??= []).push(outcome.run.id);
        } else if (!outcome.run) {
          turn.record.unresolvedNativeFollowUp = true;
        }
      }
      turn.record.steers.push({ user, after: locallyReported ? turn.emitted : after });
      await this.journal.save(turn.record);
      if (locallyReported || !options.clientMessageId) this.emitItem(turn, user);
      return { status: "accepted" };
    })();
    turn.steer = operation;
    void operation
      .finally(() => {
        if (turn.steer === operation) turn.steer = undefined;
      })
      .catch(() => {});
    try {
      return await withDeadline(
        operation,
        "Cursor SDK could not confirm steering. Check the active turn before resending.",
      );
    } catch (error) {
      locallyReported = true;
      // An unacknowledged attempt may already belong to Cursor. Throwing prevents
      // AgentManager from automatically submitting a second copy.
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn) return;
    if (turn.record.unresolvedNativeFollowUp) throw new Error(cursorUnresolvedSteerMessage());
    turn.stopRequested = true;
    if (!turn.stop) turn.nativeStopRejected = false;
    const stop = (turn.stop ??= this.stopTurn(turn));
    void stop
      .finally(() => {
        if (turn.stop === stop) turn.stop = undefined;
      })
      .catch(() => {});
    await withDeadline(
      stop,
      "Cursor SDK could not confirm that the run and its tools have stopped.",
    );
  }

  private async stopTurn(turn: CursorTurn): Promise<void> {
    if (turn.record.executionOwner) {
      turn.record.ownerStopPending = true;
      await this.journal.save(turn.record);
    }
    await this.waitForStop(turn, this.stopNative(turn));
  }

  private async waitForStop(turn: CursorTurn, stop: Promise<void>): Promise<void> {
    await stop;
    await turn.completion.catch(() => undefined);
    if (turn.record.unresolvedNativeFollowUp) throw new Error(cursorUnresolvedSteerMessage());
    if (!turn.record.joined && (turn.record.nativeRunId || turn.record.executionOwner)) {
      throw new Error("Cursor SDK could not confirm that the run and its tools have stopped.");
    }
  }

  private async stopNative(turn: CursorTurn): Promise<void> {
    if (await this.stopCompletedWriter(turn)) return;
    const run = turn.current ?? (await turn.native.catch(() => undefined));
    if (await this.stopCompletedWriter(turn)) return;
    if (!run) return;
    try {
      await this.requestCancellation(turn, run);
    } catch (error) {
      if (!(await this.stopCompletedWriter(turn))) throw error;
    }
  }

  private async stopCompletedWriter(turn: CursorTurn): Promise<boolean> {
    if (!turn.record.executionOwner || !turn.sdkWriterFinished) return false;
    // Once the final SDK writer is being fenced, its pipe may be closed. Stop
    // still targets this turn's exact retained execution domain.
    turn.nativeStopConfirmed = true;
    turn.nativeStopRejected = false;
    await this.finishOwnedExecution(turn, true, true);
    return true;
  }

  private requestCancellation(turn: CursorTurn, run: Run): Promise<void> {
    const inFlight = turn.cancellations.get(run);
    if (inFlight) return inFlight;
    const cancel = this.cancel(run).then(
      () => {
        turn.nativeStopConfirmed = true;
        return undefined;
      },
      (error: unknown) => {
        turn.nativeStopRejected = true;
        throw error;
      },
    );
    turn.cancellations.set(run, cancel);
    void cancel.catch(() => {
      if (turn.cancellations.get(run) === cancel) turn.cancellations.delete(run);
    });
    return cancel;
  }

  private async cancel(run: Run): Promise<void> {
    if (run.status === "running" && !run.supports("cancel")) {
      throw new Error("Cursor SDK cannot confirm cancellation for this run.");
    }
    await run.cancel();
    // Wait after the cancel request, when wait joins the local execution controller.
    await run.wait();
  }

  private emitItem(turn: CursorTurn, item: AgentTimelineItem): void {
    this.emit({ type: "timeline", provider: PROVIDER, turnId: turn.record.id, item });
  }

  private async observeRun(
    run: Run,
    tools: Map<string, ToolCallTimelineItem>,
    onItem: (item: AgentTimelineItem) => Promise<void>,
  ): Promise<{ result: RunResult; streamError?: unknown }> {
    let streamError: unknown;
    try {
      for await (const message of run.stream()) {
        for (const item of streamItems(message, tools)) await onItem(item);
      }
    } catch (error) {
      streamError = error;
    }
    return { result: await run.wait(), streamError };
  }

  private async observeRuns(
    turn: CursorTurn,
    firstRun: Run,
    tools: Map<string, ToolCallTimelineItem>,
    onItem: (item: AgentTimelineItem) => Promise<void>,
  ): Promise<{ result: RunResult; streamError?: unknown }> {
    let run = firstRun;
    for (;;) {
      turn.current = run;
      if (turn.stopRequested && run !== firstRun) {
        // Continue observing this owned follow-up even if its cancel fails.
        void this.requestCancellation(turn, run).catch(() => undefined);
      }
      const observed = await this.observeRun(run, tools, onItem);
      // A cancel still writing SDK state can race a replacement, even after run.wait.
      await turn.cancellations.get(run)?.catch(() => undefined);
      // The pinned local executor cannot start a new unnamed run from an
      // unacknowledged injection after its controller has joined.
      if (turn.steer) {
        await withDeadline(turn.steer, "Cursor SDK steering did not settle.").catch(
          () => undefined,
        );
      }
      const followUp = turn.followUp;
      if (!followUp) {
        if (turn.record.unresolvedNativeFollowUp) {
          return await this.holdUnconfirmed(turn, cursorUnresolvedSteerMessage());
        }
        if (turn.record.executionOwner) {
          turn.sdkWriterFinished = true;
          const mustStop = turn.stopRequested && !turn.nativeStopRejected;
          const naturallyFinished = !mustStop && observed.result.status === "finished";
          if (naturallyFinished && turn.nativeStopRejected) turn.record.ownerStopPending = false;
          await this.finishOwnedExecution(
            turn,
            !naturallyFinished,
            observed.result.status === "cancelled" && turn.nativeStopConfirmed === true,
          );
          turn.completedWriter = naturallyFinished;
          if (turn.stopRequested && !turn.nativeStopRejected && naturallyFinished) {
            await this.finishOwnedExecution(turn);
            turn.completedWriter = false;
          }
        } else {
          if (turn.stopRequested || observed.result.status === "cancelled")
            await this.confirmToolExit(turn);
          turn.record.joined = true;
        }
        return observed;
      }
      turn.followUp = undefined;
      run = followUp;
    }
  }

  private async finishOwnedExecution(
    turn: CursorTurn,
    waitForTools = true,
    cancelTools = turn.nativeStopConfirmed === true,
  ): Promise<void> {
    const owner = turn.record.executionOwner;
    if (!owner) return;
    try {
      if (turn.finishExecution) await turn.finishExecution(waitForTools, cancelTools);
      else await waitForExecutionOwner(owner);
    } catch {
      await this.holdUnconfirmed(
        turn,
        "Paseo could not confirm that the previous execution owner stopped. The saved chat is still available.",
      );
    }
  }

  private async commitTerminalTurn(turn: CursorTurn): Promise<void> {
    if (!turn.record.executionOwner || turn.record.joined) return this.journal.save(turn.record);
    try {
      if (!this.reconcileOwnedTerminal)
        throw new Error("Cursor SDK owner reconciliation unavailable.");
      await this.reconcileOwnedTerminal(
        turn.record,
        turn.completedWriter ? "completed-writer" : "domain-released",
      );
    } catch {
      return await this.holdUnconfirmed(
        turn,
        "The old Cursor SDK owner stopped, but its saved run could not be reconciled.",
      );
    }
  }

  private async confirmToolExit(turn: CursorTurn): Promise<void> {
    await turn.toolProcesses.waitForKnownGroupsToExit();
    if (turn.toolProcesses.canConfirmShellOwnership) return;
    await this.holdUnconfirmed(
      turn,
      "Paseo could not verify that Cursor SDK's shell processes stopped. Check the original host before starting work in another session.",
    );
  }

  private async holdUnconfirmed(turn: CursorTurn, message: string): Promise<never> {
    this.emitItem(turn, { type: "error", message });
    // Settling would let the manager acknowledge Stop and dispatch a queued
    // turn despite having no teardown proof. Retain the durable guard.
    return new Promise<never>(() => {});
  }

  private async consume(turn: CursorTurn): Promise<AgentRunResult> {
    const { id, user } = turn.record;
    const timeline: AgentTimelineItem[] = [];
    const tools = new Map<string, ToolCallTimelineItem>();
    let streamedText = "";
    let result: RunResult | undefined;
    let admitted = false;
    let persistenceError: unknown;
    const emitItem = async (item: AgentTimelineItem) => {
      if (item.type === "tool_call" && item.name === "shell" && item.status === "running") {
        turn.toolProcesses.observeShellCall(item.callId);
      }
      item = limitAgentTimelineItemContent(item);
      if (!persistenceError) {
        try {
          await this.journal.append(id, item);
        } catch (error) {
          persistenceError = error;
        }
      }
      timeline.push(item);
      if (item.type === "assistant_message") streamedText += item.text;
      turn.emitted++;
      this.emitItem(turn, item);
    };

    try {
      const run = await turn.native;
      admitted = true;
      if (!turn.record.nativeRunId) {
        turn.record.nativeRunId = run.id;
        try {
          await this.journal.save(turn.record);
        } catch (error) {
          persistenceError = error;
        }
      }
      this.emit({ type: "turn_started", provider: PROVIDER, turnId: id });
      this.emitItem(turn, user);
      timeline.push(user);

      const observed = await this.observeRuns(turn, run, tools, emitItem);
      result = observed.result;
      if (observed.streamError && result.status === "finished") throw observed.streamError;

      for (const item of terminalTools(tools, result.status)) await emitItem(item);
      if (result.status === "error") {
        throw new Error(result.error?.message ?? "Cursor SDK run failed.");
      }
      if (result.status === "finished" && !streamedText && result.result) {
        await emitItem({ type: "assistant_message", text: result.result });
      }
      if (persistenceError) {
        throw new Error("Cursor SDK could not persist the complete transcript.", {
          cause: persistenceError,
        });
      }
      return await this.finishTurn(turn, result, timeline, streamedText);
    } catch (error) {
      return this.failTurn(turn, error, admitted, result?.error?.code);
    }
  }

  private async failTurn(
    turn: CursorTurn,
    error: unknown,
    admitted: boolean,
    errorCode: string | undefined,
  ): Promise<never> {
    const message = messageOf(error);
    turn.record.terminal = { status: "error", message, code: errorCode };
    if (turn.record.executionOwner && !turn.record.joined) {
      turn.sdkWriterFinished = true;
      await this.finishOwnedExecution(turn);
      turn.completedWriter = false;
    }
    if (admitted && !turn.record.joined && !turn.record.executionOwner) {
      await this.journal.save(turn.record).catch(() => {});
      return await this.holdUnconfirmed(turn, message);
    }
    try {
      await this.commitTerminalTurn(turn);
    } finally {
      if (
        this.active === turn &&
        (turn.record.joined || (!turn.record.nativeRunId && !turn.record.executionOwner))
      ) {
        this.active = undefined;
      }
      // startTurn rejection is projected by AgentManager before a turn has started.
      if (admitted)
        this.emit({
          type: "turn_failed",
          provider: PROVIDER,
          turnId: turn.record.id,
          error: message,
          code: errorCode,
        });
    }
    throw error;
  }

  private async finishTurn(
    turn: CursorTurn,
    result: RunResult,
    timeline: AgentTimelineItem[],
    streamedText: string,
  ): Promise<AgentRunResult> {
    const usage = this.mapUsage(result.usage);
    turn.record.terminal =
      result.status === "cancelled"
        ? { status: "cancelled" }
        : {
            status: "finished",
            fallback: result.result,
          };
    await this.commitTerminalTurn(turn);
    if (turn.stopRequested && !turn.nativeStopRejected && turn.completedWriter) {
      await this.finishOwnedExecution(turn);
      turn.record.ownerStopPending = false;
      await this.journal.save(turn.record);
    }
    if (this.active === turn) this.active = undefined;
    const owner = turn.record.executionOwner;
    if (owner && turn.completedWriter) {
      // The turn has passed its last Stop gate. Retire the domain only after
      // an intentional background process exits on its own.
      void waitForExecutionOwner(owner)
        .then(() => forgetReleasedExecutionOwner(owner))
        .catch(() => undefined);
    }
    if (result.status === "cancelled") {
      this.emit({
        type: "turn_canceled",
        provider: PROVIDER,
        turnId: turn.record.id,
        reason: "Cursor SDK run canceled.",
      });
      return {
        sessionId: this.sessionId,
        finalText: streamedText,
        timeline,
        usage,
        canceled: true,
      };
    }
    this.emit({ type: "turn_completed", provider: PROVIDER, turnId: turn.record.id, usage });
    return {
      sessionId: this.sessionId,
      finalText: result.result ?? streamedText,
      timeline,
      usage,
    };
  }
}
