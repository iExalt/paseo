import { describe, expect, it, vi } from "vitest";
import { speakWithHandler } from "./speak-service.js";

describe("speakWithHandler", () => {
  it("awaits the registered caller handler with normalized text", async () => {
    let finishPlayback: (() => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPlayback = resolve;
        }),
    );
    const speak = speakWithHandler({
      callerAgentId: "agent-1",
      resolveSpeakHandler: () => handler,
      text: "  hello  ",
    });

    expect(handler).toHaveBeenCalledWith({ text: "hello", callerAgentId: "agent-1" });
    let completed = false;
    void speak.then(() => {
      completed = true;
      return completed;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    finishPlayback?.();
    await speak;
    expect(completed).toBe(true);
  });

  it("preserves scoped-caller and missing-handler errors", async () => {
    const resolveSpeakHandler = vi.fn(() => null);
    await expect(speakWithHandler({ text: "hello", resolveSpeakHandler })).rejects.toThrow(
      "speak is only available to agent-scoped tool sessions",
    );
    await expect(
      speakWithHandler({
        callerAgentId: "agent-1",
        resolveSpeakHandler,
        text: "hello",
      }),
    ).rejects.toThrow("No speak handler registered for your session 'agent-1'");
    expect(resolveSpeakHandler).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the caller aborts and passes the signal to playback", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const handler = vi.fn(({ signal }: { signal?: AbortSignal }) => {
      receivedSignal = signal;
      return new Promise<void>(() => {});
    });
    const speak = speakWithHandler({
      callerAgentId: "agent-1",
      resolveSpeakHandler: () => handler,
      signal: controller.signal,
      text: "hello",
    });

    controller.abort(new Error("cancelled"));
    await expect(speak).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
  });

  it("does not invoke playback when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const handler = vi.fn();
    const speak = speakWithHandler({
      callerAgentId: "agent-1",
      resolveSpeakHandler: () => handler,
      signal: controller.signal,
      text: "hello",
    });

    await expect(speak).rejects.toThrow("already cancelled");
    expect(handler).not.toHaveBeenCalled();
  });
});
