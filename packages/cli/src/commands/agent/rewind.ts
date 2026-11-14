import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { resolveAgentTarget } from "../../utils/agent-target.js";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";

interface RewindOptions extends CommandOptions {
  to?: string;
  mode?: string;
}
interface RewindResult {
  agentId: string;
  messageId: string;
  mode: "conversation" | "files" | "both";
  changed: true;
}
const schema: OutputSchema<RewindResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT", field: "agentId" },
    { header: "MESSAGE", field: "messageId" },
    { header: "MODE", field: "mode" },
    { header: "CHANGED", field: "changed" },
  ],
};
export function addRewindOptions(command: Command): Command {
  return command
    .description("Rewind an agent conversation, files, or both")
    .argument("<id>", "Agent ID, prefix, or full session ID")
    .requiredOption("--to <message-id>", "User message ID from the timeline")
    .option("--mode <mode>", "conversation, files, or both", "conversation");
}
export async function runRewindCommand(
  id: string,
  options: RewindOptions,
  _command: Command,
): Promise<SingleResult<RewindResult>> {
  const mode = options.mode ?? "conversation";
  if (mode !== "conversation" && mode !== "files" && mode !== "both")
    throw { code: "INVALID_ARGUMENT", message: "--mode must be conversation, files, or both." };
  const messageId = options.to?.trim();
  if (!messageId) throw { code: "INVALID_ARGUMENT", message: "--to must name a user message." };
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const agentId = await resolveAgentTarget(client, id);
    const snapshot = await client.fetchAgent({ agentId });
    const capabilities = snapshot?.agent.capabilities;
    const supported = {
      conversation: capabilities?.supportsRewindConversation,
      files: capabilities?.supportsRewindFiles,
      both: capabilities?.supportsRewindBoth,
    };
    if (supported[mode] !== true)
      throw { code: "UNSUPPORTED_FEATURE", message: `This agent cannot rewind ${mode}.` };
    await client.rewindAgent(agentId, messageId, mode);
    return { type: "single", data: { agentId, messageId, mode, changed: true }, schema };
  } finally {
    await client.close();
  }
}
