import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { mapClaudeCompletedToolCall } from "./tool-call-mapper.js";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSyntheticUserEntry(entry: Record<string, unknown>): boolean {
  return entry.isSynthetic === true || entry.isMeta === true || Boolean(entry.toolUseResult);
}

interface SettledSkillCall {
  callId: string;
  input: unknown;
}

function settledSkillCall(
  item: Extract<AgentTimelineItem, { type: "tool_call" }> | null,
  input: unknown,
): SettledSkillCall | null {
  if (item?.name !== "Skill" || item.status !== "completed") return null;
  return { callId: item.callId, input: input ?? null };
}

const CLAUDE_SKILL_CONTENT_PREFIX = "Base directory for this skill: ";

/**
 * Reads the SKILL.md body Claude Code injects for a Skill call. The first line names the skill's
 * directory, whose basename must match the skill (`plugin:name` loads from `.../name`).
 */
function readClaudeSkillContent(input: {
  content: unknown;
  skillName: string | null;
}): string | null {
  const blocks =
    typeof input.content === "string" ? [{ type: "text", text: input.content }] : input.content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .map((block) => toObjectRecord(block))
    .find((block) => block?.type === "text" && typeof block.text === "string")?.text;
  if (typeof text !== "string" || !text.startsWith(CLAUDE_SKILL_CONTENT_PREFIX)) return null;
  if (input.skillName) {
    const directory =
      text.slice(CLAUDE_SKILL_CONTENT_PREFIX.length).split("\n", 1)[0]?.trim() ?? "";
    const expected = input.skillName.slice(input.skillName.lastIndexOf(":") + 1);
    if (directory.split(/[\\/]/).at(-1) !== expected) return null;
  }
  return text;
}

export class ClaudeSkillContent {
  private pending: SettledSkillCall | null = null;

  remember(item: Extract<AgentTimelineItem, { type: "tool_call" }> | null, input: unknown): void {
    this.pending = settledSkillCall(item, input);
  }

  reset(): void {
    this.pending = null;
  }

  /** Turns the synthetic SKILL.md message that follows a Skill call into that call's output. */
  consume(entry: unknown): Extract<AgentTimelineItem, { type: "tool_call" }> | null {
    const skill = this.pending;
    if (!skill) return null;
    const record = toObjectRecord(entry);
    if (!record || !isSyntheticUserEntry(record)) return null;
    // History records name the call. The live stream does not, so there the body must follow the
    // call directly and name the same skill.
    const sourceToolUseId = readTrimmedString(record.sourceToolUseID);
    if (sourceToolUseId && sourceToolUseId !== skill.callId) return null;
    const text = readClaudeSkillContent({
      content: toObjectRecord(record.message)?.content,
      skillName: sourceToolUseId
        ? null
        : (readTrimmedString(toObjectRecord(skill.input)?.skill) ?? null),
    });
    if (!text) return null;
    this.pending = null;
    return mapClaudeCompletedToolCall({
      name: "Skill",
      callId: skill.callId,
      input: skill.input,
      output: text,
    });
  }
}
