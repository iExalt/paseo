import { beforeEach, describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  confirmNotificationReceipt,
  projectNotificationPreview,
  receiveNotificationPreview,
  retainNotificationOpenIntent,
  useNotificationReceipt,
} from "./preview";

const preview = {
  v: 1,
  kind: "assistant",
  epoch: "epoch",
  seqStart: 2,
  seqEnd: 5,
  timestamp: "2026-11-06T00:00:00.000Z",
  text: "The completed response.",
  truncated: false,
};
const row = (seq: number, text: string): StreamItem => ({
  kind: "assistant_message",
  id: `row-${seq}`,
  timelineCursor: { epoch: "epoch", seq },
  text,
  timestamp: new Date(preview.timestamp),
});
function project(
  tail: StreamItem[] = [],
  head: StreamItem[] = [],
  range: { epoch: string; endSeq: number } | null = null,
  authoritative = false,
) {
  return projectNotificationPreview({
    tail,
    head,
    range,
    authoritative,
    receipt: useNotificationReceipt.getState().receipt,
    pendingPermissionIds: [],
  });
}

describe("notification receipt presentation", () => {
  beforeEach(() => {
    useNotificationReceipt.setState({ receipt: null });
    receiveNotificationPreview("host", "agent", "tap", { preview });
  });

  it("paints cold content without advancing any canonical cursor or input", () => {
    const tail: StreamItem[] = [];
    const result = project(tail);
    expect(result.head).toHaveLength(1);
    expect(result.head[0]).toMatchObject({ text: preview.text });
    expect(result.head[0]?.timelineCursor).toBeUndefined();
    expect(result.tail).toBe(tail);
    expect(tail).toEqual([]);
  });

  it("reuses an overlapping partial's key, removes its head continuation and replaces once", () => {
    const tail = [row(2, "The ")];
    const head = [row(3, "completed response.")];
    const before = project(tail, head);
    expect(before.tail).toEqual([expect.objectContaining({ id: "row-2", text: preview.text })]);
    expect(before.head).toEqual([]);
    expect(tail[0]).toMatchObject({ text: "The " });
    const full = [row(5, preview.text)];
    const after = project(full, [], { epoch: "epoch", endSeq: 5 }, true);
    expect(after.previewId).toBeNull();
    expect(after.tail).toBe(full);
    expect(after.head).toEqual([]);
  });

  it("does not replace longer local content or a newer live response", () => {
    const longer = [row(4, preview.text + " More detail.")];
    expect(project(longer).previewId).toBeNull();
    const head = [row(6, "Newer response")];
    expect(project([], head).head).toBe(head);
    expect(project([], head).previewId).toBeNull();
  });

  it("distinguishes a provisional old cache epoch from current canonical coverage", () => {
    const tail = [
      {
        ...row(10, "Old cached history"),
        timelineCursor: { epoch: "old", seq: 10 },
      },
    ];
    expect(project(tail).head).toHaveLength(1);
    expect(project(tail).tail).toBe(tail);
    expect(project(tail, [], { epoch: "old", endSeq: 10 }, true).previewId).toBeNull();
    expect(project(tail, [], { epoch: "epoch", endSeq: 6 }, true).previewId).toBeNull();
  });

  it("keeps the newer receipt across out-of-order taps and rejects unknown or reversed snapshots", () => {
    receiveNotificationPreview("host", "agent", "old-tap", {
      preview: { ...preview, seqEnd: 4, text: "Older" },
    });
    expect(useNotificationReceipt.getState().receipt).toMatchObject({
      tapId: "old-tap",
      preview: { seqEnd: 5 },
    });
    receiveNotificationPreview("host", "agent", "bad", {
      preview: { ...preview, v: 2 },
    });
    expect(project().previewId).toBeNull();
    receiveNotificationPreview("host", "agent", "bad", {
      preview: { ...preview, seqStart: 6 },
    });
    expect(project().previewId).toBeNull();
  });

  it("keeps permissions read-only until a post-tap authoritative fetch or actual request arrives", () => {
    receiveNotificationPreview("host", "agent", "permission", {
      preview: {
        v: 1,
        kind: "permission",
        requestId: "p",
        text: "Approve command",
        truncated: true,
      },
    });
    const receipt = useNotificationReceipt.getState().receipt;
    expect(project().previewId).toBe("notification:p");
    expect(
      projectNotificationPreview({
        tail: [],
        head: [],
        receipt,
        range: null,
        authoritative: false,
        pendingPermissionIds: ["p"],
      }).previewId,
    ).toBeNull();
    confirmNotificationReceipt(receipt);
    expect(project().previewId).toBeNull();
    receiveNotificationPreview("host", "agent", "next", { preview });
    confirmNotificationReceipt(receipt);
    expect(useNotificationReceipt.getState().receipt?.tapId).toBe("next");
  });
});

describe("notification entry intent", () => {
  it("records a new entry even when a legacy or malformed payload has no usable preview", () => {
    receiveNotificationPreview("host", "agent", "legacy", {});
    expect(useNotificationReceipt.getState()).toMatchObject({
      receipt: null,
      openIntent: { serverId: "host", agentId: "agent", tapId: "legacy" },
    });
    receiveNotificationPreview("host", "agent", "invalid", {
      preview: { v: 99 },
    });
    expect(useNotificationReceipt.getState()).toMatchObject({
      receipt: null,
      openIntent: { tapId: "invalid" },
    });
  });

  it("latches each chat's entry across other taps, preserving identity until a new matching tap", () => {
    const first = { serverId: "host", agentId: "agent", tapId: "one" };
    const other = { serverId: "host", agentId: "other", tapId: "two" };
    const next = { ...first, tapId: "three" };
    const cached = retainNotificationOpenIntent(null, first, "host", "agent");
    expect(cached).toBe(first);
    expect(retainNotificationOpenIntent(cached, first, "host", "agent")).toBe(first);
    expect(retainNotificationOpenIntent(cached, other, "host", "agent")).toBe(first);
    expect(retainNotificationOpenIntent(cached, next, "host", "agent")).toBe(next);
    expect(retainNotificationOpenIntent(cached, other, "different-host", "agent")).toBeNull();
    expect(retainNotificationOpenIntent(cached, other, "host", "other")).toBe(other);
  });
});
