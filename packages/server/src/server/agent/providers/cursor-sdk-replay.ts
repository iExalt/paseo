import type { InteractionUpdate, RunResult, SDKMessage } from "@cursor/sdk";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import { isProviderImageMessage } from "./provider-image-output.js";

type TrackedMessage = "assistant" | "thinking" | "tool_call" | "user";

const NO_PROGRESS = "Agent turn stopped after repeated resume attempts made no progress";

function trackedMessage(type: SDKMessage["type"]): type is TrackedMessage {
  return type === "assistant" || type === "thinking" || type === "tool_call" || type === "user";
}

/** Retry callbacks can run ahead of the reader, which awaits journal writes. */
export class CursorReplayHoldback {
  private readonly expected = new Map<number, TrackedMessage>();
  private readonly boundaries = new Map<number, "reconnect" | "reset" | "tool">();
  private produced = 0;
  private consumed = 0;
  private textInAttempt = false;
  private ended = false;
  private pendingToolRequests = 0;
  private disabled = false;
  private answer = "";
  private held?: AgentTimelineItem[];

  onDelta(update: InteractionUpdate): void {
    if (this.disabled) return;
    // The local SDK awaits onDelta before writing the matching stream message.
    switch (update.type) {
      case "text-delta":
        this.expected.set(++this.produced, "assistant");
        this.textInAttempt ||= Boolean(update.text.trim());
        break;
      case "thinking-delta":
      case "thinking-completed":
        this.expected.set(++this.produced, "thinking");
        this.textInAttempt = false;
        break;
      case "user-message-appended":
        this.expected.set(++this.produced, "user");
        this.textInAttempt = false;
        break;
      case "tool-call-started":
      case "partial-tool-call":
      case "tool-call-completed":
        this.expected.set(++this.produced, "tool_call");
        this.textInAttempt = false;
        if (update.type === "tool-call-completed" && this.pendingToolRequests > 0) {
          this.pendingToolRequests--;
        }
        break;
      case "tool-requests-listed":
        if (update.callCount > 0) {
          this.pendingToolRequests = update.callCount;
          this.ended = false;
          this.boundaries.set(this.produced, "tool");
        }
        return;
      case "turn-ended":
        this.ended = this.textInAttempt && this.pendingToolRequests === 0;
        return;
      default:
        return;
    }
    this.ended = false;
  }

  reconnect(): void {
    if (this.disabled) return;
    // A model call can end before tools. The native turn-ended update means
    // the answer was delivered even if its terminal checkpoint was lost.
    if (!this.boundaries.has(this.produced)) {
      this.boundaries.set(this.produced, this.ended ? "reconnect" : "reset");
    }
    this.textInAttempt = false;
    this.ended = false;
    this.pendingToolRequests = 0;
  }

  private applyBoundary(hasRunningTools: () => boolean): AgentTimelineItem[] {
    const boundary = this.boundaries.get(this.consumed);
    if (!boundary) return [];
    this.boundaries.delete(this.consumed);
    if (boundary === "tool") return this.release();
    if (!this.held) {
      if (boundary === "reconnect" && this.answer.trim() && !hasRunningTools()) this.held = [];
      else this.answer = "";
    }
    return [];
  }

  private align(type: SDKMessage["type"], hasRunningTools: () => boolean): AgentTimelineItem[] {
    if (this.disabled || !trackedMessage(type)) return [];
    if (this.expected.get(this.consumed + 1) !== type) return this.disable();
    const released = this.applyBoundary(hasRunningTools);
    this.expected.delete(++this.consumed);
    return released;
  }

  observe(
    message: SDKMessage,
    items: AgentTimelineItem[],
    hasRunningTools: () => boolean,
  ): AgentTimelineItem[] {
    const { type } = message;
    let released = this.align(type, hasRunningTools);
    if (
      type === "tool_call" ||
      type === "user" ||
      type === "summary" ||
      (type === "assistant" && message.message.content.some((block) => block.type !== "text"))
    ) {
      released = released.concat(this.release());
    }
    if (this.held) {
      if (this.hasImage(items)) return released.concat(this.disable(), items);
      this.held.push(...items);
      return released;
    }
    if (!this.disabled) {
      for (const item of items) this.rememberVisibleAnswer(item);
    }
    return released.length ? released.concat(items) : items;
  }

  private hasImage(items: AgentTimelineItem[]): boolean {
    let previous = this.held?.at(-1);
    for (const item of items) {
      if (item.type === "assistant_message") {
        // A single Markdown image can be split across adjacent SDK text deltas.
        const leading = previous?.type === "assistant_message" ? previous.text.slice(-1) : "";
        if ((leading + item.text).includes("![") || isProviderImageMessage(item.text)) return true;
      }
      previous = item;
    }
    return false;
  }

  private rememberVisibleAnswer(item: AgentTimelineItem): void {
    if (item.type === "reasoning") this.answer = "";
    if (item.type !== "assistant_message" || isProviderImageMessage(item.text)) return;
    const visible = limitAgentTimelineItemContent(item);
    if (visible.type === "assistant_message") this.answer += visible.text;
  }

  private release(): AgentTimelineItem[] {
    const items = this.held ?? [];
    this.held = undefined;
    this.answer = "";
    return items;
  }

  disable(): AgentTimelineItem[] {
    this.disabled = true;
    this.expected.clear();
    this.boundaries.clear();
    return this.release();
  }

  finish(
    result: RunResult,
    canSuppress: boolean,
    hasRunningTools: () => boolean,
  ): { result: RunResult; items: AgentTimelineItem[] } {
    const released = this.applyBoundary(hasRunningTools);
    const noProgress = result.status === "error" && result.error?.message === NO_PROGRESS;
    if (
      this.held &&
      canSuppress &&
      this.expected.size === 0 &&
      (result.status === "finished" || noProgress)
    ) {
      const { error: _error, ...rest } = result;
      result = { ...rest, status: "finished", result: this.answer };
      this.held = undefined;
    }
    return { result, items: released.concat(this.disable()) };
  }
}
