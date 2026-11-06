import fs from "node:fs/promises";
import path from "node:path";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";

interface CodexSkillInput {
  name: string;
  path: string;
}

function readSkillInputs(content: unknown): CodexSkillInput[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return record.type === "skill" &&
      typeof record.name === "string" &&
      typeof record.path === "string"
      ? [{ name: record.name, path: record.path }]
      : [];
  });
}

function stripFrontMatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).trim();
}

async function readSkillText(skill: CodexSkillInput): Promise<string> {
  const directory = `Base directory for this skill: ${path.dirname(skill.path)}`;
  try {
    return `${directory}\n\n${stripFrontMatter(await fs.readFile(skill.path, "utf8"))}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${directory}\n\nPaseo could not read \`${skill.path}\`: ${reason}`;
  }
}

/**
 * Codex has no Skill tool: a skill picked for a turn rides in the user message as a
 * `{ type: "skill", name, path }` input, and Codex adds SKILL.md to the model's context without
 * reporting it. Show each one as a Skill card, like Claude's and OpenCode's, so its text can be
 * opened. The text is read from disk when the card is built, so a skill edited since the turn
 * shows its current text.
 */
export async function codexUserMessageSkillCalls(input: {
  messageId: string | null;
  content: unknown;
}): Promise<ToolCallTimelineItem[]> {
  const skills = readSkillInputs(input.content);
  return await Promise.all(
    skills.map(async (skill, index): Promise<ToolCallTimelineItem> => ({
      type: "tool_call",
      callId: `codex-skill:${input.messageId ?? skill.path}:${index}`,
      name: "Skill",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        label: skill.name,
        icon: "sparkles",
        markdown: true,
        text: await readSkillText(skill),
      },
    })),
  );
}
