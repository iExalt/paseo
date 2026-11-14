import { describe, expect, test } from "vitest";
import {
  resolveAgentIdentifierFrom,
  type AgentIdentifierSources,
  type ResolvableLiveAgent,
  type ResolvableStoredAgent,
} from "./resolve-agent-identifier.js";

function stored(
  id: string,
  options: Partial<ResolvableStoredAgent> & {
    runtime?: string | null;
    persisted?: string;
    archivedAt?: string;
  } = {},
): ResolvableStoredAgent {
  const { runtime, persisted, ...rest } = options;
  return {
    id,
    ...(runtime !== undefined ? { runtimeInfo: { sessionId: runtime } } : {}),
    persistence: persisted ? { sessionId: persisted } : null,
    ...rest,
  };
}

function live(
  id: string,
  options: Partial<ResolvableLiveAgent> & { runtime?: string | null; persisted?: string } = {},
): ResolvableLiveAgent {
  const { runtime, persisted, ...rest } = options;
  return {
    id,
    ...(runtime !== undefined ? { runtimeInfo: { sessionId: runtime } } : {}),
    persistence: persisted ? { sessionId: persisted } : null,
    ...rest,
  };
}

function sources(input: Partial<AgentIdentifierSources>): AgentIdentifierSources {
  return { live: [], stored: [], isRetiredInternalAgent: () => false, ...input };
}

describe("resolveAgentIdentifierFrom with provider session IDs", () => {
  test("live state wins over a stale stored session ID, and a stale ID still finds its owner", () => {
    // A rotated its session from S1 to S2; B was persisted with S1 and is not live.
    const input = sources({
      live: [live("agent-a", { runtime: "S2", persisted: "S1" })],
      stored: [
        stored("agent-a", { runtime: "S1", persisted: "S1" }),
        stored("agent-b", { persisted: "S1" }),
      ],
    });

    expect(resolveAgentIdentifierFrom("S2", input)).toEqual({ ok: true, agentId: "agent-a" });
    expect(resolveAgentIdentifierFrom("S1", input)).toEqual({ ok: true, agentId: "agent-b" });
  });

  test("matches only the effective ID: runtime first, persisted when runtime is null", () => {
    const input = sources({
      stored: [
        stored("agent-a", { runtime: "runtime-a", persisted: "persisted-a" }),
        stored("agent-b", { runtime: null, persisted: "persisted-b" }),
      ],
    });

    expect(resolveAgentIdentifierFrom("persisted-a", input)).toMatchObject({
      ok: false,
      notFound: true,
    });
    expect(resolveAgentIdentifierFrom("runtime-a", input)).toEqual({
      ok: true,
      agentId: "agent-a",
    });
    expect(resolveAgentIdentifierFrom("persisted-b", input)).toEqual({
      ok: true,
      agentId: "agent-b",
    });
  });

  test("resolves a live agent that has no stored record yet", () => {
    const input = sources({ live: [live("agent-live", { runtime: "S-live" })] });

    expect(resolveAgentIdentifierFrom(" S-live ", input)).toEqual({
      ok: true,
      agentId: "agent-live",
    });
  });

  test("never matches or lists internal agents by session ID", () => {
    const input = sources({
      live: [live("agent-internal-live", { runtime: "S-shared", internal: true })],
      stored: [
        stored("agent-public", { persisted: "S-shared", title: "Public" }),
        stored("agent-internal-stored", { persisted: "S-internal", internal: true }),
        // A stored copy that forgot the flag is still internal while the live agent says so.
        stored("agent-internal-live", { persisted: "S-internal-live" }),
      ],
    });

    expect(resolveAgentIdentifierFrom("S-shared", input)).toEqual({
      ok: true,
      agentId: "agent-public",
    });
    expect(resolveAgentIdentifierFrom("S-internal", input)).toMatchObject({
      ok: false,
      notFound: true,
    });
    expect(resolveAgentIdentifierFrom("S-internal-live", input)).toMatchObject({
      ok: false,
      notFound: true,
    });
  });

  test("rejects a session ID several agents hold, listing every Paseo ID and title", () => {
    const input = sources({
      live: [live("agent-active", { runtime: "S-dup", config: { title: "Live title" } })],
      stored: [
        stored("agent-active", { persisted: "S-dup", title: "Active agent" }),
        stored("agent-archived", {
          persisted: "S-dup",
          title: "Archived agent",
          archivedAt: "2026-11-01",
        }),
        stored("agent-untitled", { persisted: "S-dup" }),
      ],
    });

    const result = resolveAgentIdentifierFrom("S-dup", input);

    expect(result).toEqual({
      ok: false,
      notFound: false,
      error: [
        'Session ID "S-dup" matches 3 agents. Use a Paseo agent ID instead:',
        "  agent-active  Active agent",
        "  agent-archived  Archived agent",
        "  agent-untitled",
      ].join("\n"),
    });
  });

  test("resolves an archived agent by its session ID", () => {
    const input = sources({
      stored: [stored("agent-archived", { persisted: "S-old", archivedAt: "x" })],
    });

    expect(resolveAgentIdentifierFrom("S-old", input)).toEqual({
      ok: true,
      agentId: "agent-archived",
    });
  });

  test("an exact Paseo ID wins over another agent's equal session ID", () => {
    const input = sources({
      stored: [stored("agent-a"), stored("agent-b", { persisted: "agent-a" })],
    });

    expect(resolveAgentIdentifierFrom("agent-a", input)).toEqual({ ok: true, agentId: "agent-a" });
  });

  test("a session ID wins over a Paseo ID prefix and a title", () => {
    const input = sources({
      stored: [
        stored("abc-agent-prefix"),
        stored("agent-titled", { title: "abc" }),
        stored("agent-native", { persisted: "abc" }),
      ],
    });

    expect(resolveAgentIdentifierFrom("abc", input)).toEqual({ ok: true, agentId: "agent-native" });
  });

  test("does not match a session ID prefix", () => {
    const input = sources({ stored: [stored("agent-a", { persisted: "0199-session-id" })] });

    expect(resolveAgentIdentifierFrom("0199-session", input)).toEqual({
      ok: false,
      notFound: true,
      error: "Agent not found: 0199-session",
    });
  });
});

describe("resolveAgentIdentifierFrom keeps its Paseo ID behavior", () => {
  const input = sources({
    live: [live("internal-live", { internal: true })],
    stored: [
      stored("abc12345-one", { title: "Same" }),
      stored("abc98765-two", { title: "Same" }),
      stored("def00000-three", { title: "Unique" }),
      stored("internal-stored", { internal: true, title: "Hidden" }),
    ],
    isRetiredInternalAgent: (agentId) => agentId === "internal-retired",
  });

  test.each([
    ["exact", "abc12345-one", { ok: true, agentId: "abc12345-one" }],
    ["unique prefix", "def", { ok: true, agentId: "def00000-three" }],
    ["unique title", "Unique", { ok: true, agentId: "def00000-three" }],
    ["live internal by exact ID", "internal-live", { ok: true, agentId: "internal-live" }],
    ["retired internal by exact ID", "internal-retired", { ok: true, agentId: "internal-retired" }],
    ["stored internal stays hidden", "internal-stored", { ok: false, notFound: true }],
    ["internal title stays hidden", "Hidden", { ok: false, notFound: true }],
    ["ambiguous prefix", "abc", { ok: false, notFound: false }],
    ["ambiguous title", "Same", { ok: false, notFound: false }],
    ["empty", "  ", { ok: false, notFound: false, error: "Agent identifier cannot be empty" }],
  ])("%s", (_name, identifier, expected) => {
    expect(resolveAgentIdentifierFrom(identifier, input)).toMatchObject(expected);
  });
});
