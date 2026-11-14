import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";
import type { CommandError } from "../output/index.js";

export async function resolvePromptInput(
  options: {
    promptArgument: string | undefined;
    promptOption: string | undefined;
    promptFile: string | undefined;
  },
  stdin: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<string> {
  const providedSourceCount = [
    options.promptArgument,
    options.promptOption,
    options.promptFile,
  ].filter((source) => source !== undefined).length;

  if (providedSourceCount > 1) {
    throw {
      code: "CONFLICTING_PROMPT_INPUT",
      message: "Provide exactly one of prompt argument, --prompt, or --prompt-file",
    } satisfies CommandError;
  }

  let prompt = options.promptArgument ?? options.promptOption;
  const promptFilePath = options.promptFile?.trim();
  if (promptFilePath) {
    try {
      prompt =
        promptFilePath === "-"
          ? await text(stdin)
          : await readFile(resolve(promptFilePath), "utf8");
    } catch (error) {
      throw {
        code: "PROMPT_FILE_READ_ERROR",
        message: `Failed to read prompt file: ${promptFilePath}`,
        details: error instanceof Error ? error.message : String(error),
      } satisfies CommandError;
    }
  }

  if (!prompt?.trim()) {
    throw {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details:
        "Provide a prompt argument, --prompt <text>, or --prompt-file <path> (use - for stdin)",
    } satisfies CommandError;
  }

  return prompt;
}
