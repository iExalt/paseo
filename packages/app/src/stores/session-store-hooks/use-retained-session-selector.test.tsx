/**
 * @vitest-environment jsdom
 */
import { act, render } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, it } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { useRetainedSessionSelector } from "./use-retained-session-selector";

const SERVER_ID = "server-retained";

function setHead(agentId: string, text: string): void {
  const head: StreamItem[] = [
    { kind: "assistant_message", id: "live", text, timestamp: new Date(0) } as StreamItem,
  ];
  useSessionStore.getState().setAgentStreamState(SERVER_ID, agentId, { head });
}

function renderHeadProbe() {
  const seen: string[] = [];
  function HeadProbe({ agentId }: { agentId: string }) {
    const head = useRetainedSessionSelector(`${SERVER_ID}\u0000${agentId}`, (state) =>
      state.sessions[SERVER_ID]?.agentStreamHead.get(agentId),
    );
    const item = head?.[0];
    seen.push(item?.kind === "assistant_message" ? item.text : "");
    return null;
  }
  const view = (active: boolean, agentId: string) => (
    <RetainedPanelActivity active={active}>
      <HeadProbe agentId={agentId} />
    </RetainedPanelActivity>
  );
  return { seen, view };
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

it("does not render a hidden panel for its agent's stream commits and shows the latest on reveal", () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  setHead("agent-a", "first");
  const { seen, view } = renderHeadProbe();
  const { rerender } = render(view(true, "agent-a"));

  rerender(view(false, "agent-a"));
  act(() => {
    setHead("agent-a", "second");
    setHead("agent-a", "third");
  });
  expect(seen).toEqual(["first", "first"]);

  rerender(view(true, "agent-a"));
  expect(seen.at(-1)).toBe("third");
});

it("reads live state once when a panel mounts hidden or switches agents while hidden", () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  setHead("agent-a", "a");
  setHead("agent-b", "b");
  const { seen, view } = renderHeadProbe();
  const { rerender } = render(view(false, "agent-a"));

  rerender(view(false, "agent-b"));
  act(() => setHead("agent-b", "b2"));

  expect(seen).toEqual(["a", "b"]);
});
