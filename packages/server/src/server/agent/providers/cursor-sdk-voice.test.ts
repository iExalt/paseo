import { expect, test, vi } from "vitest";
import type { PaseoToolCatalog, PaseoToolDefinition } from "../tools/types.js";
import { cursorSpeakTool } from "./cursor-sdk-voice.js";

test("accepts one playback for an identified root call and revokes retries with the activation", async () => {
  const abort = new AbortController();
  const definition = {} as PaseoToolDefinition;
  const lookup = vi.fn<PaseoToolCatalog["getTool"]>().mockReturnValue(definition);
  const play = vi.fn<PaseoToolCatalog["executeTool"]>().mockResolvedValue({ content: [] });
  const tool = cursorSpeakTool(
    "agent-root",
    {
      getTool: lookup,
      executeTool: play,
      tools: new Map([["speak", definition]]),
    },
    abort.signal,
  );
  const root = { sessionId: "agent-root", toolCallId: "call-1" };

  expect(
    await tool.execute({ text: "Hello." }, { ...root, sessionId: "agent-child" }),
  ).toMatchObject({ isError: true });
  expect(await tool.execute({ text: "Hello." }, { toolCallId: "call-1" })).toMatchObject({
    isError: true,
  });
  expect(await tool.execute({ text: "Hello.", agentId: "target" }, root)).toMatchObject({
    isError: true,
  });
  const first = tool.execute({ text: " Hello. " }, root);
  expect(tool.execute({ text: "Hello." }, root)).toBe(first);
  expect(await tool.execute({ text: "Changed." }, root)).toMatchObject({ isError: true });
  expect(await first).toEqual({ content: [{ type: "text", text: "Spoken." }] });
  expect(play).toHaveBeenCalledExactlyOnceWith(
    "speak",
    { text: "Hello." },
    { signal: abort.signal },
  );

  lookup.mockReturnValue(undefined);
  expect(await tool.execute({ text: "Hello." }, root)).toMatchObject({ isError: true });
  lookup.mockReturnValue(definition);
  abort.abort();
  expect(await tool.execute({ text: "Hello." }, { ...root, toolCallId: "call-2" })).toMatchObject({
    isError: true,
  });
  expect(play).toHaveBeenCalledTimes(1);
});
