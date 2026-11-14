import { describe, expect, test } from "vitest";

import { dropRewoundBranches } from "./rewound-branches.js";

function row(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function chain(uuid: string, parentUuid: string | null, type = "user"): string {
  return row({ type, uuid, parentUuid });
}

function rewindTo(leafUuid: string): string {
  return row({ type: "last-prompt", leafUuid, rewound: true });
}

function uuidsOf(content: string): string[] {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { uuid?: string; messageId?: string; type: string })
    .map((entry) => entry.uuid ?? `${entry.type}:${entry.messageId ?? ""}`);
}

describe("dropRewoundBranches", () => {
  test("drops the turns a rewind cut and keeps the branch written after it", () => {
    const transcript = [
      chain("u1", null),
      // Parallel tool calls: each result hangs off its own tool_use, so the second call's
      // result is a sibling branch of the main chain, not a rewound one.
      chain("a1-tool-1", "u1", "assistant"),
      chain("a1-tool-2", "a1-tool-1", "assistant"),
      chain("r1", "a1-tool-1"),
      chain("r2", "a1-tool-2"),
      chain("a1", "r2", "assistant"),
      chain("u2", "a1"),
      row({ type: "file-history-snapshot", messageId: "u2" }),
      chain("a2", "u2", "assistant"),
      rewindTo("a1"),
      chain("u3", "a1"),
      chain("a3", "u3", "assistant"),
    ].join("\n");

    expect(uuidsOf(dropRewoundBranches(transcript))).toEqual([
      "u1",
      "a1-tool-1",
      "a1-tool-2",
      "r1",
      "r2",
      "a1",
      "last-prompt:",
      "u3",
      "a3",
    ]);
  });

  test("applies each rewind to what existed when it happened", () => {
    const transcript = [
      chain("u1", null),
      chain("a1", "u1", "assistant"),
      chain("u2", "a1"),
      chain("a2", "u2", "assistant"),
      rewindTo("a1"),
      chain("u3", "a1"),
      chain("a3", "u3", "assistant"),
      rewindTo("a1"),
      chain("u4", "a1"),
    ].join("\n");

    expect(uuidsOf(dropRewoundBranches(transcript))).toEqual([
      "u1",
      "a1",
      "last-prompt:",
      "last-prompt:",
      "u4",
    ]);
  });

  test("a later rewind further back also cuts the turns an earlier rewind kept", () => {
    const transcript = [
      chain("u1", null),
      chain("a1", "u1", "assistant"),
      chain("u2", "a1"),
      chain("a2", "u2", "assistant"),
      chain("u3", "a2"),
      rewindTo("a2"),
      rewindTo("a1"),
      chain("u4", "a1"),
    ].join("\n");

    expect(uuidsOf(dropRewoundBranches(transcript))).toEqual([
      "u1",
      "a1",
      "last-prompt:",
      "last-prompt:",
      "u4",
    ]);
  });

  test("applies a rewind whose marker Claude has not written yet", () => {
    const transcript = [
      chain("u1", null),
      chain("a1", "u1", "assistant"),
      chain("u2", "a1"),
      chain("a2", "u2", "assistant"),
    ].join("\n");

    expect(uuidsOf(dropRewoundBranches(transcript, { pendingRewind: { leafUuid: "a1" } }))).toEqual(
      ["u1", "a1"],
    );
    expect(uuidsOf(dropRewoundBranches(transcript, { pendingRewind: { leafUuid: null } }))).toEqual(
      [],
    );
    // Once the marker lands, applying the same rewind again cuts nothing more.
    expect(
      uuidsOf(
        dropRewoundBranches(`${transcript}\n${rewindTo("a1")}`, {
          pendingRewind: { leafUuid: "a1" },
        }),
      ),
    ).toEqual(["u1", "a1", "last-prompt:"]);
  });

  test("returns a transcript with no rewinds unchanged", () => {
    const transcript = [chain("u1", null), chain("a1", "u1", "assistant")].join("\n");

    expect(dropRewoundBranches(transcript)).toBe(transcript);
  });
});

test("preserves transcript bytes when a rewind marker cuts no rows", () => {
  const content = [chain("u1", null), rewindTo("u1"), ""].join("\r\n");
  expect(dropRewoundBranches(content)).toBe(content);
});
