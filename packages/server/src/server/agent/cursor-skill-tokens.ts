import {
  isCursorSkillTokenName,
  SKILL_TOKEN_TRAILING_PUNCTUATION,
  splitSkillTokenCode,
} from "@getpaseo/protocol/messages";
import type { AgentPromptInput } from "./agent-sdk-types.js";

interface NamedCursorSkill {
  name: string;
  reference: { id: string; scope: "workspace" | "user" };
}

/**
 * The text the user typed. Pasted text, chat history and other attachments carry a MIME type, so
 * a `/name` inside them never selects a skill.
 */
export function cursorSkillPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n");
}

function withoutCode(text: string): string {
  return splitSkillTokenCode(text)
    .map((part, index) => (index % 2 === 1 ? " " : part))
    .join("");
}

/**
 * Candidate names for each `/token` at the start of the text or after whitespace, longest first:
 * `/deploy:` tries `deploy:`, then `deploy`. Code spans and fences never hold tokens.
 */
export function cursorSkillTokenCandidates(text: string): string[][] {
  const tokens: string[][] = [];
  for (const match of withoutCode(text).matchAll(/(?<=^|\s)\/(\S+)/g)) {
    // No skill name holds a slash, so a path never costs a catalog scan.
    if (match[1].includes("/")) continue;
    const candidates: string[] = [];
    for (let name = match[1]; name; name = name.slice(0, -1)) {
      candidates.push(name);
      if (!SKILL_TOKEN_TRAILING_PUNCTUATION.test(name)) break;
    }
    tokens.push(candidates);
  }
  return tokens;
}

/** One skill per name: a workspace skill beats a user skill, then the catalog's order decides. */
export function preferredCursorSkills<T extends NamedCursorSkill>(skills: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const skill of skills) {
    const current = byName.get(skill.name);
    if (!current || (current.reference.scope === "user" && skill.reference.scope === "workspace")) {
      byName.set(skill.name, skill);
    }
  }
  return skills.filter((skill) => byName.get(skill.name) === skill);
}

/** The skills the text's `/name` tokens select, once each, in order of first mention. */
export function matchCursorSkillTokens<T extends NamedCursorSkill>(
  text: string,
  skills: readonly T[],
): T[] {
  const tokens = cursorSkillTokenCandidates(text);
  if (!tokens.length) return [];
  const byName = new Map(
    preferredCursorSkills(skills)
      .filter((skill) => isCursorSkillTokenName(skill.name))
      .map((skill) => [skill.name, skill]),
  );
  const matched = new Map<string, T>();
  for (const candidates of tokens) {
    const skill = candidates.map((name) => byName.get(name)).find((found) => found !== undefined);
    if (skill && !matched.has(skill.reference.id)) matched.set(skill.reference.id, skill);
  }
  return [...matched.values()];
}
