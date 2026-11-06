import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";

export interface CodexSkillInput {
  name: string;
  path: string;
}

/** Where a Skill card's SKILL.md comes from: what Codex gave the model, or the file on disk. */
export interface CodexSkillTextSource {
  /** `turnId` is the Codex turn whose user message carried the skill input. */
  read(skill: CodexSkillInput, turnId: string | undefined): Promise<string>;
}

// A card waits this long for SKILL.md on disk. Live reads run in the session's serial
// notification queue, so a hung filesystem must not hold up the rest of the turn.
const SKILL_FILE_TIMEOUT_MS = 2_000;

class SkillReadTimeoutError extends Error {
  constructor(skillPath: string, timeoutMs: number) {
    super(`Paseo stopped waiting for ${skillPath} after ${timeoutMs} ms`);
    this.name = "SkillReadTimeoutError";
  }
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
  const text = markdown.replace(/^\uFEFF/, "");
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

async function readSkillFile(skillPath: string, timeoutMs: number): Promise<string> {
  const read = fs.readFile(skillPath, "utf8");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SkillReadTimeoutError(skillPath, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads SKILL.md from disk as the turn starts, which is when Codex reads it for the model. */
export function createLiveCodexSkillTextSource(
  timeoutMs = SKILL_FILE_TIMEOUT_MS,
): CodexSkillTextSource {
  return { read: (skill) => readSkillFile(skill.path, timeoutMs) };
}

export const liveCodexSkillTextSource = createLiveCodexSkillTextSource();

const INJECTED_SKILL_PATTERN =
  /^<skill>\n<name>[^\n]*<\/name>\n<path>([^\n]*)<\/path>\n([\s\S]*)\n<\/skill>\s*$/;

interface RolloutUserMessage {
  type?: unknown;
  role?: unknown;
  content?: unknown;
}

function injectionKey(turnId: string, skillPath: string): string {
  return `${turnId}\n${skillPath}`;
}

function parseRolloutLine(line: string): RolloutLine | null {
  try {
    return JSON.parse(line) as RolloutLine;
  } catch {
    // A rollout being written can end in a partial line.
    return null;
  }
}

interface RolloutLine {
  type?: unknown;
  payload?: RolloutUserMessage & { turn_id?: unknown };
}

/**
 * Collects the SKILL.md text Codex injected for each skill input, by turn and path, from the
 * thread's rollout. `thread/read` returns the skill input but not that text; the rollout keeps it
 * as a user `response_item` of the form `<skill>\n<name>…</name>\n<path>…</path>\n<SKILL.md>\n</skill>`
 * after the turn's `task_started` and `turn_context` lines name the turn. Keying by turn keeps
 * injections without a Paseo card (a `$skill` typed in the text) and rewound turns from
 * shifting text onto another turn's card.
 */
async function readInjectedSkillTexts(rolloutPath: string): Promise<Map<string, string[]>> {
  const texts = new Map<string, string[]>();
  const lines = createInterface({
    input: createReadStream(rolloutPath, "utf8"),
    crlfDelay: Infinity,
  });
  let turnId: string | null = null;
  for await (const line of lines) {
    // Skip lines that neither name a turn nor inject a skill before parsing them.
    const injects = line.includes('"type":"response_item"') && line.includes("<skill>\\n<name>");
    const startsTurn =
      line.includes('"type":"turn_context"') || line.includes('"type":"task_started"');
    if (!injects && !startsTurn) continue;
    const parsed = parseRolloutLine(line);
    if (!parsed) continue;
    const startedTurnId = readStartedTurnId(parsed);
    if (startedTurnId) {
      turnId = startedTurnId;
    } else if (injects && turnId) {
      for (const [skillPath, text] of readInjectedSkills(parsed.payload)) {
        const key = injectionKey(turnId, skillPath);
        texts.set(key, [...(texts.get(key) ?? []), text]);
      }
    }
  }
  return texts;
}

function readStartedTurnId(line: RolloutLine): string | null {
  const payload = line.payload;
  const startsTurn = line.type === "turn_context" || payload?.type === "task_started";
  return startsTurn && typeof payload?.turn_id === "string" ? payload.turn_id : null;
}

function readInjectedSkills(payload: RolloutLine["payload"]): Array<[string, string]> {
  if (payload?.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) {
    return [];
  }
  return (payload.content as Array<{ text?: unknown } | null>).flatMap(
    (block): Array<[string, string]> => {
      const match =
        typeof block?.text === "string" ? INJECTED_SKILL_PATTERN.exec(block.text) : null;
      return match?.[1] && match[2] !== undefined ? [[match[1], match[2]]] : [];
    },
  );
}

/**
 * Replays the text the model saw for each skill input. A thread without a readable rollout, or a
 * skill its turn lacks there, falls back to the file on disk.
 */
export function createHistoryCodexSkillTextSource(
  readRolloutPath: () => Promise<string | null>,
): CodexSkillTextSource {
  let injected: Promise<Map<string, string[]>> | null = null;
  return {
    async read(skill, turnId) {
      injected ??= readRolloutPath()
        .then((rolloutPath) =>
          rolloutPath ? readInjectedSkillTexts(rolloutPath) : new Map<string, string[]>(),
        )
        .catch(() => new Map<string, string[]>());
      const texts = await injected;
      const text = turnId ? texts.get(injectionKey(turnId, skill.path))?.shift() : undefined;
      return text ?? (await readSkillFile(skill.path, SKILL_FILE_TIMEOUT_MS));
    },
  };
}

/**
 * Codex has no Skill tool: a skill picked for a turn rides in the user message as a
 * `{ type: "skill", name, path }` input, and Codex adds SKILL.md to the model's context without
 * reporting it. Show each one as a Skill card, like Claude's and OpenCode's, so its text can be
 * opened. A SKILL.md that can't be read makes a failed card that says why.
 */
export async function codexUserMessageSkillCalls(input: {
  messageId: string | null;
  turnId: string | undefined;
  content: unknown;
  source: CodexSkillTextSource;
}): Promise<ToolCallTimelineItem[]> {
  // Reads start in input order, so a history source hands out a turn's injections in order.
  return await Promise.all(
    readSkillInputs(input.content).map((skill, index) => skillCall(input, skill, index)),
  );
}

async function skillCall(
  input: { messageId: string | null; turnId: string | undefined; source: CodexSkillTextSource },
  skill: CodexSkillInput,
  index: number,
): Promise<ToolCallTimelineItem> {
  const base = {
    type: "tool_call" as const,
    callId: `codex-skill:${input.messageId ?? skill.path}:${index}`,
    name: "Skill",
  };
  const directory = `Base directory for this skill: ${path.dirname(skill.path)}`;
  try {
    const text = stripFrontMatter(await input.source.read(skill, input.turnId));
    return {
      ...base,
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        label: skill.name,
        icon: "sparkles",
        markdown: true,
        text: `${directory}\n\n${text}`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      status: "failed",
      error: { message: `Paseo could not read ${skill.path}: ${message}` },
      detail: { type: "plain_text", label: skill.name, icon: "sparkles" },
    };
  }
}
