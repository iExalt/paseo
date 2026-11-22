import type { AgentPromptInput, AgentSlashCommand } from "../agent-sdk-types.js";

export const cursorCompactCommand: AgentSlashCommand = {
  name: "compact",
  description: "Summarize the saved conversation to free context",
  argumentHint: "",
  kind: "command",
};

export function isCursorCompactPrompt(prompt: AgentPromptInput): boolean {
  return typeof prompt === "string" && prompt.trim() === "/compact";
}
