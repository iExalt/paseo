import { normalizeSpeakText } from "@getpaseo/protocol/speech/speak-text";
import type { VoiceSpeakHandler } from "../voice-types.js";

interface SpeakWithHandlerInput {
  callerAgentId?: string;
  resolveSpeakHandler: (callerAgentId: string) => VoiceSpeakHandler | null;
  signal?: AbortSignal;
  text: string;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The speak request was aborted", "AbortError");
}

export async function speakWithHandler(input: SpeakWithHandlerInput): Promise<void> {
  const text = normalizeSpeakText(input.text);
  if (!input.callerAgentId) {
    throw new Error("speak is only available to agent-scoped tool sessions");
  }

  const handler = input.resolveSpeakHandler(input.callerAgentId);
  if (!handler) {
    throw new Error(`No speak handler registered for your session '${input.callerAgentId}'`);
  }

  input.signal?.throwIfAborted();
  const speaking = handler({ text, callerAgentId: input.callerAgentId, signal: input.signal });
  if (!input.signal) {
    await speaking;
    return;
  }

  const signal = input.signal;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      speaking,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
