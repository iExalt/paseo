import { Command } from "commander";
import { normalizeSpeakText } from "@getpaseo/protocol/speech/speak-text";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

interface SpeechSpeakResult {
  ok: true;
}

const speechSpeakSchema: OutputSchema<SpeechSpeakResult> = {
  idField: "ok",
  columns: [{ header: "STATUS", field: (result) => (result.ok ? "spoken" : "failed") }],
};

export function createSpeechCommand(): Command {
  const speech = new Command("speech").description("Speech commands");
  addJsonAndDaemonHostOptions(
    speech
      .command("speak")
      .description("Speak text through the daemon-managed voice session")
      .argument("<text>", "Text to speak (1–4000 characters)")
      .option("--agent <id>", "Agent whose active voice session should speak"),
  ).action(withOutput(runSpeechSpeakCommand));
  return speech;
}

export async function runSpeechSpeakCommand(
  text: string,
  options: CommandOptions & { agent?: string },
  _command: Command,
): Promise<SingleResult<SpeechSpeakResult>> {
  let normalizedText: string;
  try {
    normalizedText = normalizeSpeakText(text);
  } catch (error) {
    throw {
      code: "INVALID_SPEECH_TEXT",
      message: error instanceof Error ? error.message : String(error),
      details: "Provide 1–4000 non-whitespace characters.",
    } satisfies CommandError;
  }

  const requestedAgentId = options.agent?.trim();
  if (options.agent !== undefined && !requestedAgentId) {
    throw {
      code: "INVALID_AGENT_ID",
      message: "--agent cannot be empty.",
    } satisfies CommandError;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });
  const abortController = new AbortController();
  const abort = () => abortController.abort(new Error("Speech command interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    // COMPAT(voiceSpeakCli): added in v0.11.2; remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.voiceSpeakCli !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support CLI speech.",
        details: "Update the daemon before using `paseo speech speak`.",
      } satisfies CommandError;
    }
    const callerAgentId = requestedAgentId || (await resolveCallerAgentId(client));
    await client.speakText(
      {
        text: normalizedText,
        ...(callerAgentId ? { callerAgentId } : {}),
      },
      { signal: abortController.signal },
    );
    return { type: "single", data: { ok: true }, schema: speechSpeakSchema };
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await client.close().catch(() => undefined);
  }
}
