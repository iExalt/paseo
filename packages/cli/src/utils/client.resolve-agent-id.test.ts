import { describe, expect, test } from "vitest";
import { resolveAgentId } from "./client.js";

const agents = [
  { id: "abc1234-full-agent-id", title: "Build docs" },
  { id: "def5678-other-agent-id", title: "Fix archive flow" },
  { id: "987zyxw-third-agent-id", title: "Review PR" },
];

describe("resolveAgentId", () => {
  test.each([
    ["exact ID", "abc1234-full-agent-id", "abc1234-full-agent-id"],
    ["ID prefix", "def5678", "def5678-other-agent-id"],
    ["exact name, case-insensitively", "fix archive flow", "def5678-other-agent-id"],
    ["unique partial name", "review", "987zyxw-third-agent-id"],
    ["missing agent", "does not exist", null],
  ])("resolves %s", (_name, query, expected) => {
    expect(resolveAgentId(query, agents)).toBe(expected);
  });

  test("rejects an ID prefix several agents share instead of picking one", () => {
    const shared = [
      { id: "abc1234-first", title: "First" },
      { id: "abc1234-second", title: null },
    ];
    expect(() => resolveAgentId("abc1234", shared)).toThrow(
      expect.objectContaining({
        code: "AMBIGUOUS_AGENT_ID",
        message:
          'Agent ID prefix "abc1234" matches 2 agents. Use a longer prefix or the full agent ID:\n  abc1234-first  First\n  abc1234-second',
      }),
    );
  });

  test("a title substring does not settle a prefix several agents share", () => {
    const shared = [
      { id: "abc1234-first", title: "First" },
      { id: "abc1234-second", title: null },
      { id: "zzz9999-third", title: "Fix abc1234 crash" },
    ];
    expect(() => resolveAgentId("abc1234", shared)).toThrow(
      expect.objectContaining({ code: "AMBIGUOUS_AGENT_ID" }),
    );
  });

  test("a unique title still settles a prefix several agents share", () => {
    const shared = [
      { id: "review-1", title: "Other" },
      { id: "review-2", title: "Review" },
    ];
    expect(resolveAgentId("review", shared)).toBe("review-2");
  });

  describe("provider session IDs", () => {
    const withSessions = [
      ...agents,
      {
        id: "fed0001-claude-agent-id",
        title: "Claude agent",
        runtimeInfo: { sessionId: "0199aaaa-runtime-session" },
        persistence: { sessionId: "0199aaaa-stale-session" },
      },
      { id: "fed0002-codex-agent-id", title: "Codex agent", persistence: { sessionId: "abc1234" } },
    ];

    test("resolves the agent's effective session ID: runtime first, never the stale handle", () => {
      expect(resolveAgentId("0199aaaa-runtime-session", withSessions)).toBe(
        "fed0001-claude-agent-id",
      );
      expect(resolveAgentId("0199aaaa-stale-session", withSessions)).toBeNull();
    });

    test("a session ID beats another agent's ID prefix", () => {
      expect(resolveAgentId("abc1234", withSessions)).toBe("fed0002-codex-agent-id");
    });

    test("an exact Paseo ID beats another agent's equal session ID", () => {
      const clash = [
        ...withSessions,
        { id: "fed0003", persistence: { sessionId: "abc1234-full-agent-id" } },
      ];
      expect(resolveAgentId("abc1234-full-agent-id", clash)).toBe("abc1234-full-agent-id");
    });

    test("does not match a session ID prefix", () => {
      expect(resolveAgentId("0199aaaa-runtime", withSessions)).toBeNull();
    });

    test("rejects a session ID several agents hold instead of picking one", () => {
      const duplicated = [
        { id: "aaa0001", title: "First", persistence: { sessionId: "thread-dup" } },
        { id: "bbb0002", title: null, runtimeInfo: { sessionId: "thread-dup" } },
      ];
      let thrown: unknown;
      try {
        resolveAgentId("thread-dup", duplicated);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual({
        code: "AMBIGUOUS_AGENT_ID",
        message:
          'Session ID "thread-dup" matches 2 agents. Use a Paseo agent ID instead:\n  aaa0001  First\n  bbb0002',
      });
    });
  });
});
