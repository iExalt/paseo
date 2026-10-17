import { describe, expect, test } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { EditBatcher } from "./edit-batcher";

function harness() {
  const sent: Array<{ changes: ChangeSet; length: number }> = [];
  let timer: (() => void) | null = null;
  const batcher = new EditBatcher((changes, length) => sent.push({ changes, length }), {
    setTimeout: (callback) => {
      timer = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => (timer = null),
  });
  return { batcher, sent, fire: () => timer?.(), pending: () => timer !== null };
}

describe("EditBatcher", () => {
  test("sends each edit of a small document at once", () => {
    const { batcher, sent, pending } = harness();
    batcher.add(ChangeSet.of({ from: 0, insert: "a" }, 0), 1);
    expect(sent).toHaveLength(1);
    expect(pending()).toBe(false);
  });

  test("composes the edits of a large document into one send", () => {
    const { batcher, sent, fire } = harness();
    const doc = Text.of(["x".repeat(200_000)]);
    const first = ChangeSet.of({ from: 0, insert: "a" }, doc.length);
    const second = ChangeSet.of({ from: 1, insert: "b" }, doc.length + 1);
    batcher.add(first, doc.length + 1);
    batcher.add(second, doc.length + 2);
    expect(sent).toHaveLength(0);
    fire();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBe(doc.length + 2);
    expect(sent[0]!.changes.apply(doc).sliceString(0, 3)).toBe("abx");
  });

  test("flush sends what waits, and reset drops it", () => {
    const { batcher, sent, pending } = harness();
    const length = 200_000;
    batcher.add(ChangeSet.of({ from: 0, insert: "a" }, length), length + 1);
    batcher.flush();
    expect(sent).toHaveLength(1);
    expect(pending()).toBe(false);
    batcher.add(ChangeSet.of({ from: 0, insert: "b" }, length + 1), length + 2);
    batcher.reset();
    batcher.flush();
    expect(sent).toHaveLength(1);
  });
});
