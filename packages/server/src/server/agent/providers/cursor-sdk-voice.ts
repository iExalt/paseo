import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { MAX_SPEAK_TEXT_LENGTH } from "@getpaseo/protocol/speech/speak-text";
import { z } from "zod";
import type { PaseoToolCatalog } from "../tools/types.js";

export const cursorSpeakToolName = "speak";

const input = z.strictObject({
  text: z.string().trim().min(1).max(MAX_SPEAK_TEXT_LENGTH),
});

export const cursorSpeakToolDescriptor = {
  description:
    "Speak to the user through this agent's active voice conversation. Waits for playback.",
  inputSchema: z.toJSONSchema(input, { io: "input" }) as NonNullable<SDKCustomTool["inputSchema"]>,
} satisfies Omit<SDKCustomTool, "execute">;

function errorResult(text: string): SDKCustomToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function cursorSpeakTool(
  nativeAgentId: string,
  catalog: PaseoToolCatalog,
  signal: AbortSignal,
): SDKCustomTool {
  const calls = new Map<string, { text: string; result: Promise<SDKCustomToolResult> }>();
  return {
    ...cursorSpeakToolDescriptor,
    execute: (args, context) => {
      if (signal.aborted) return errorResult("Voice playback was canceled.");
      if (!catalog.getTool("speak")) return errorResult("Voice playback is no longer active.");
      if (context?.sessionId !== nativeAgentId || !context.toolCallId) {
        return errorResult("Voice playback is available only to the active Cursor SDK chat.");
      }
      const parsed = input.safeParse(args);
      if (!parsed.success) return errorResult("Provide nonempty text up to 4000 characters.");
      const { text } = parsed.data;
      const previous = calls.get(context.toolCallId);
      if (previous) {
        return previous.text === text
          ? previous.result
          : errorResult("The text changed while retrying. Speak it as a new call.");
      }
      const result = catalog
        .executeTool("speak", { text }, { signal })
        .then((played): SDKCustomToolResult =>
          played.isError
            ? errorResult("The active voice conversation could not play this text.")
            : { content: [{ type: "text", text: "Spoken." }] },
        )
        .catch(() => errorResult("The active voice conversation could not play this text."));
      calls.set(context.toolCallId, { text, result });
      return result;
    },
  };
}
