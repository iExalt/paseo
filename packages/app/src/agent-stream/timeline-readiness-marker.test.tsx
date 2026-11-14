// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import { closedTurnsKey, readClosedTurns } from "./timeline-readiness";
import { useCountClosedTurns } from "./timeline-readiness-marker";

const SERVER_ID = "srv-readiness";
const AGENT_ID = "agent-readiness";
const OPEN: TurnLiveness = {
  phase: "open",
  turnId: "turn-1",
  startedAt: null,
  cancellationRequestId: null,
};

function setTurn(turn: TurnLiveness) {
  useSessionStore.setState((state) => {
    const session = state.sessions[SERVER_ID]!;
    const agentDetails = new Map(session.agentDetails);
    agentDetails.set(AGENT_ID, { ...agentDetails.get(AGENT_ID), turn } as Agent);
    return { sessions: { ...state.sessions, [SERVER_ID]: { ...session, agentDetails } } };
  });
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

it("counts a turn that opens and closes before React renders, once for two panes", () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  const key = closedTurnsKey(SERVER_ID, AGENT_ID);
  const first = renderHook(() => useCountClosedTurns(SERVER_ID, AGENT_ID));
  const second = renderHook(() => useCountClosedTurns(SERVER_ID, AGENT_ID));

  act(() => {
    setTurn(OPEN);
    setTurn(TURN_LIVENESS_IDLE);
  });
  expect(readClosedTurns(key)).toBe(1);

  first.unmount();
  second.unmount();
  act(() => {
    setTurn(OPEN);
    setTurn(TURN_LIVENESS_IDLE);
  });
  expect(readClosedTurns(key)).toBe(1);
});
