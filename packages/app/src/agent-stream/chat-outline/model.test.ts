import { describe, expect, it } from "vitest";
import {
  chatOutlineAvailable,
  railIndexAt,
  createActivePromptPublisher,
  shouldAcceptPromptIndexEpoch,
  promptTickMagnification,
  resolveActivePromptSeq,
  OUTLINE_MAGNIFY_RADIUS,
  type ChatOutlinePrompt,
} from "./model";

describe("chat outline prompt index epoch", () => {
  it("accepts only the authoritative timeline epoch", () => {
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-2")).toBe(true);
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-1")).toBe(false);
  });
});

function prompt(seq: number): ChatOutlinePrompt {
  return { seq, timestamp: new Date(seq).toISOString(), preview: `prompt ${seq}` };
}

describe("promptTickMagnification", () => {
  it("peaks under the pointer and decays to nothing at the radius", () => {
    expect(promptTickMagnification(0)).toBe(1);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS)).toBe(0);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS + 10)).toBe(0);
  });

  it("falls off monotonically and symmetrically around the pointer", () => {
    const above = [0, 1, 2, 3].map((distance) => promptTickMagnification(distance));
    const below = [0, -1, -2, -3].map((distance) => promptTickMagnification(distance));

    expect(above).toEqual(below);
    expect(above).toEqual([...above].sort((left, right) => right - left));
  });
});

describe("resolveActivePromptSeq", () => {
  const prompts = [prompt(2), prompt(9), prompt(20)];

  it("marks the prompt whose turn the reading position sits in", () => {
    expect(resolveActivePromptSeq(prompts, 9)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 14)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 20)).toBe(20);
    expect(resolveActivePromptSeq(prompts, 99)).toBe(20);
  });

  it("marks nothing above the first prompt or without a reading position", () => {
    expect(resolveActivePromptSeq(prompts, 1)).toBeNull();
    expect(resolveActivePromptSeq(prompts, null)).toBeNull();
    expect(resolveActivePromptSeq([], 42)).toBeNull();
  });
});

describe("createActivePromptPublisher", () => {
  it("notifies subscribers only when the active prompt changes", () => {
    const publisher = createActivePromptPublisher();
    let notifications = 0;
    const unsubscribe = publisher.subscribe(() => {
      notifications += 1;
    });

    publisher.publish(9);
    publisher.publish(9);
    publisher.publish(20);
    unsubscribe();
    publisher.publish(null);

    expect(notifications).toBe(2);
    expect(publisher.getActiveSeq()).toBeNull();
  });
});

describe("railIndexAt", () => {
  it("maps a finger to the centred band of slots and clamps outside it", () => {
    // Three 8 px slots centred on a 100 px rail fill 38..62.
    const at = (y: number) => railIndexAt({ y, height: 100, count: 3, slotHeight: 8 });
    expect([at(39), at(47), at(61)]).toEqual([0, 1, 2]);
    expect([at(0), at(100)]).toEqual([0, 2]);
  });

  it("shares the whole rail once the slots shrink to fit", () => {
    const at = (y: number) => railIndexAt({ y, height: 100, count: 50, slotHeight: 8 });
    expect([at(0), at(50), at(99.9)]).toEqual([0, 25, 49]);
  });
});

describe("chatOutlineAvailable", () => {
  it("needs a wide layout on every platform, as well as host support and the setting", () => {
    const wide = { supported: true, enabled: true, isCompact: false };
    expect(chatOutlineAvailable(wide)).toBe(true);
    expect(chatOutlineAvailable({ ...wide, isCompact: true })).toBe(false);
    expect(chatOutlineAvailable({ ...wide, supported: false })).toBe(false);
    expect(chatOutlineAvailable({ ...wide, enabled: false })).toBe(false);
  });
});
