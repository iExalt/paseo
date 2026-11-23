import type { AgentSession } from "../agent-sdk-types.js";

export type RewindMode = "conversation" | "files" | "both";

export class RewindCapabilityError extends Error {
  constructor(mode: RewindMode) {
    super(`Provider does not support rewinding ${mode}`);
    this.name = "RewindCapabilityError";
  }
}

const CAPABILITIES = {
  conversation: { flag: "supportsRewindConversation", method: "revertConversation" },
  files: { flag: "supportsRewindFiles", method: "revertFiles" },
  both: { flag: "supportsRewindBoth", method: "revertBoth" },
} as const;

/** Throws before any side effect when the session cannot rewind in this mode. */
export function assertRewindCapability(session: AgentSession, mode: RewindMode): void {
  const { flag, method } = CAPABILITIES[mode];
  if (!session.capabilities[flag] || !session[method]) throw new RewindCapabilityError(mode);
}

export async function invokeRewindCapability(
  session: AgentSession,
  input: { messageId: string; mode: RewindMode },
): Promise<void> {
  switch (input.mode) {
    case "conversation":
      if (!session.capabilities.supportsRewindConversation || !session.revertConversation) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertConversation({ messageId: input.messageId });
      return;
    case "files":
      if (!session.capabilities.supportsRewindFiles || !session.revertFiles) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertFiles({ messageId: input.messageId });
      return;
    case "both":
      if (!session.capabilities.supportsRewindBoth || !session.revertBoth) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertBoth({ messageId: input.messageId });
      return;
  }
}
