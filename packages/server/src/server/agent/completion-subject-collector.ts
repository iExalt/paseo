import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { COMPLETION_SUBJECT_MAX_LENGTH, type CompletionSubject } from "./completion-subject.js";

export { COMPLETION_SUBJECT_MAX_LENGTH, type CompletionSubject } from "./completion-subject.js";

interface AssistantSegment {
  text: string;
  messageId?: string;
  complete: boolean;
}

export class CompletionSubjectCollector {
  private segment: AssistantSegment | undefined;
  private adjacent = false;
  private identityComplete = true;

  constructor(
    private readonly turnId: string,
    private readonly maxLength = COMPLETION_SUBJECT_MAX_LENGTH,
  ) {}

  observe(turnId: string | undefined, item: AgentTimelineItem): void {
    if (turnId !== this.turnId) {
      this.invalidate();
      this.adjacent = false;
      return;
    }

    if (item.type !== "assistant_message") {
      this.adjacent = false;
      return;
    }

    const messageIdChanged =
      this.adjacent && item.messageId !== undefined && item.messageId !== this.segment?.messageId;
    if (!this.adjacent || messageIdChanged || !this.segment) {
      this.segment = this.createSegment(item.text, item.messageId);
      this.adjacent = true;
      return;
    }

    this.append(item.text);
  }

  invalidate(): void {
    this.identityComplete = false;
  }

  seal(): CompletionSubject | undefined {
    const segment = this.segment;
    if (!segment) return undefined;
    return Object.freeze({
      turnId: this.turnId,
      text: segment.text,
      completeness: segment.complete && this.identityComplete ? "complete" : "incomplete",
    });
  }

  private createSegment(text: string, messageId: string | undefined): AssistantSegment {
    return {
      text: text.slice(0, this.maxLength),
      ...(messageId === undefined ? {} : { messageId }),
      complete: text.length <= this.maxLength,
    };
  }

  private append(text: string): void {
    const segment = this.segment;
    if (!segment || !segment.complete) return;
    if (segment.text.length + text.length > this.maxLength) {
      segment.text += text.slice(0, this.maxLength - segment.text.length);
      segment.complete = false;
      return;
    }
    segment.text += text;
  }
}
