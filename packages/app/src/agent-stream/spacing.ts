import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";
import { continuesTurn } from "./turn-membership";

export function getAssistantMessageSpacing(params: {
  item: StreamItem;
  hasFooterBelow?: boolean;
}): "default" | "compactBottom" {
  return params.item.kind === "assistant_message" && params.hasFooterBelow
    ? "compactBottom"
    : "default";
}

/** A received agent message: a closed row that starts a turn, not a bubble with its own margins. */
export const isReceivedMessageItem = (item?: StreamItem | null) =>
  item?.kind === "user_message" && item.sender !== undefined;
const isUserMessageItem = (item?: StreamItem | null) =>
  item?.kind === "user_message" && item.sender === undefined;
const isToolSequenceItem = (item?: StreamItem | null) =>
  item?.kind === "tool_call" || item?.kind === "thought" || item?.kind === "todo_list";

export function getGapBetweenStreamItems(
  item: StreamItem | null,
  belowItem: StreamItem | null,
): number {
  if (!item || !belowItem) {
    return 0;
  }

  // A received message starts a turn: a turn's gap above it, and close to the rest of its turn.
  if (isReceivedMessageItem(item) || isReceivedMessageItem(belowItem)) {
    return isReceivedMessageItem(item) && continuesTurn(item, belowItem) ? SPACING[1] : SPACING[4];
  }
  if (isUserMessageItem(item) && isUserMessageItem(belowItem)) {
    return SPACING[1];
  }
  if (isUserMessageItem(item) && belowItem.kind === "assistant_message") {
    return 0;
  }
  if (isToolSequenceItem(item) && isToolSequenceItem(belowItem)) {
    return 0;
  }
  if (isUserMessageItem(item) && isToolSequenceItem(belowItem)) {
    return SPACING[4];
  }
  if (item.kind === "assistant_message" && isToolSequenceItem(belowItem)) {
    return SPACING[1];
  }
  if (isToolSequenceItem(item) && belowItem.kind === "assistant_message") {
    return SPACING[1];
  }
  return SPACING[4];
}
