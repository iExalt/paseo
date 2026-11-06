import { create } from "zustand";
import {
  NotificationPreviewSchema,
  type NotificationPreview,
} from "@getpaseo/protocol/notification-preview";
import type { StreamItem } from "@/types/stream";
import type { TimelineItemTransform } from "@/plugins/timeline/model";

export function preserveNotificationPreviewTransform(
  transform: TimelineItemTransform | undefined,
  previewId: string | null,
): TimelineItemTransform | undefined {
  if (!transform || !previewId) return transform;
  return (input) => (input.sourceId === previewId ? undefined : transform(input));
}

export interface NotificationReceipt {
  serverId: string;
  agentId: string;
  tapId: string;
  preview: NotificationPreview;
  synchronized?: boolean;
}

export interface NotificationOpenIntent {
  serverId: string;
  agentId: string;
  tapId: string;
}

// Latch a matching tap per mounted chat. A tap elsewhere must not restore an older route anchor.
export function retainNotificationOpenIntent(
  cached: NotificationOpenIntent | null,
  latest: NotificationOpenIntent | null,
  serverId: string,
  agentId: string,
): NotificationOpenIntent | null {
  const matches = (intent: NotificationOpenIntent | null) =>
    intent?.serverId === serverId && intent.agentId === agentId;
  if (matches(latest)) return latest;
  return matches(cached) ? cached : null;
}

// Only the most recently opened notification needs provisional content; never persist it.
export const useNotificationReceipt = create<{
  receipt: NotificationReceipt | null;
  openIntent: NotificationOpenIntent | null;
}>(() => ({ receipt: null, openIntent: null }));

export function confirmNotificationReceipt(receipt: NotificationReceipt | null): void {
  if (receipt && useNotificationReceipt.getState().receipt === receipt) {
    useNotificationReceipt.setState({
      receipt: { ...receipt, synchronized: true },
    });
  }
}

export function receiveNotificationPreview(
  serverId: string,
  agentId: string,
  tapId: string,
  data: Record<string, unknown> | undefined,
): void {
  const openIntent = { serverId, agentId, tapId };
  const parsed = NotificationPreviewSchema.safeParse(data?.preview);
  if (
    !parsed.success ||
    (parsed.data.kind === "assistant" && parsed.data.seqStart > parsed.data.seqEnd)
  ) {
    useNotificationReceipt.setState({ receipt: null, openIntent });
    return;
  }
  const previous = useNotificationReceipt.getState().receipt;
  const next = parsed.data;
  if (
    previous?.serverId === serverId &&
    previous.agentId === agentId &&
    previous.preview.kind === "assistant" &&
    next.kind === "assistant" &&
    previous.preview.epoch === next.epoch &&
    (previous.preview.seqEnd > next.seqEnd ||
      (previous.preview.seqEnd === next.seqEnd && previous.preview.text.length >= next.text.length))
  ) {
    useNotificationReceipt.setState({
      openIntent,
      receipt: { ...previous, tapId },
    });
    return;
  }
  useNotificationReceipt.setState({
    openIntent,
    receipt: { serverId, agentId, tapId, preview: next },
  });
}

export function projectNotificationPreview(input: {
  tail: StreamItem[];
  head: StreamItem[];
  receipt: NotificationReceipt | null;
  authoritative: boolean;
  range: { epoch: string; endSeq: number } | null;
  pendingPermissionIds: readonly string[];
}): { tail: StreamItem[]; head: StreamItem[]; previewId: string | null } {
  const { tail, head, receipt, range } = input;
  const unchanged = { tail, head, previewId: null };
  if (!receipt) return unchanged;
  const preview = receipt.preview;
  if (preview.kind === "permission") {
    if (receipt.synchronized || input.pendingPermissionIds.includes(preview.requestId))
      return unchanged;
    const id = `notification:${preview.requestId}`;
    return {
      tail,
      head: [
        ...head,
        {
          kind: "assistant_message",
          id,
          text: preview.text,
          timestamp: new Date(0),
        },
      ],
      previewId: id,
    };
  }
  if (
    input.authoritative &&
    range &&
    (range.epoch !== preview.epoch || range.endSeq >= preview.seqEnd)
  )
    return unchanged;
  const sameMessage = (item: StreamItem) =>
    item.kind === "assistant_message" &&
    item.timelineCursor?.epoch === preview.epoch &&
    item.timelineCursor.seq >= preview.seqStart &&
    item.timelineCursor.seq <= preview.seqEnd;
  const rows = [...tail, ...head];
  if (
    rows.some(
      (item) =>
        item.timelineCursor?.epoch === preview.epoch &&
        item.timelineCursor.seq > preview.seqEnd &&
        (item.kind === "assistant_message" || item.kind === "user_message"),
    )
  )
    return unchanged;
  const overlap = rows.filter(sameMessage);
  if (
    overlap.some(
      (item) =>
        item.kind === "assistant_message" &&
        (item.text.length >= preview.text.length ||
          !(preview.text.startsWith(item.text) || preview.text.endsWith(item.text))),
    )
  )
    return unchanged;
  const existing = overlap[0];
  const id = existing?.id ?? `notification:${preview.epoch}:${preview.seqStart}`;
  // No timeline cursor: presentation cannot claim coverage or become a fork boundary.
  const row: StreamItem = {
    kind: "assistant_message",
    id,
    text: preview.text,
    timestamp: new Date(preview.timestamp),
  };
  const replace = (item: StreamItem): StreamItem[] => {
    if (item === existing) return [row];
    return sameMessage(item) ? [] : [item];
  };
  if (existing && tail.includes(existing)) {
    return {
      tail: tail.flatMap(replace),
      head: head.filter((item) => !sameMessage(item)),
      previewId: id,
    };
  }
  return {
    tail,
    head: existing ? head.flatMap(replace) : [...head, row],
    previewId: id,
  };
}
