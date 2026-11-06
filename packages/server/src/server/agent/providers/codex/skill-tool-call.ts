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
  read(skill: CodexSkillInput): Promise<string>;
}

// A live card waits this long for SKILL.md. The read runs in the session's serial
// notification queue, so a hung filesystem must not hold up the rest of the turn.
const LIVE_READ_TIMEOUT_MS = 2_000;

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
  const text = markdown.replace(/^﻿/, "");
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

async function readSkillFile(skillPath: string, timeoutMs?: number): Promise<string> {
  const read = fs.readFile(skillPath, "utf8");
  if (timeoutMs === undefined) return await read;
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
  timeoutMs = LIVE_READ_TIMEOUT_MS,
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

/**
 * Collects the SKILL.md text Codex injected for each skill input, in order, from the thread's
 * rollout. `thread/read` returns the skill input but not that text; the rollout keeps it as a
 * user `response_item` of the form `<skill>\n<name>…</name>\n<path>…</path>\n<SKILL.md>\n</skill>`.
 */
async function readInjectedSkillTexts(rolloutPath: string): Promise<Map<string, string[]>> {
  const texts = new Map<string, string[]>();
  const lines = createInterface({
    input: createReadStream(rolloutPath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Most lines are not skill injections; skip them before parsing.
    if (!line.includes('"type":"response_item"') || !line.includes("<skill>\\n<name>")) continue;
    const payload = (JSON.parse(line) as { payload?: RolloutUserMessage }).payload;
    if (payload?.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) {
      continue;
    }
    for (const block of payload.content as Array<{ text?: unknown } | null>) {
      if (typeof block?.text !== "string") continue;
      const match = INJECTED_SKILL_PATTERN.exec(block.text);
      if (!match?.[1] || match[2] === undefined) continue;
      texts.set(match[1], [...(texts.get(match[1]) ?? []), match[2]]);
    }
  }
  return texts;
}

/**
 * Replays the text the model saw for each skill input, in history order. A thread without a
 * readable rollout, or a skill the rollout lacks, falls back to the file on disk.
 */
export function createHistoryCodexSkillTextSource(
  readRolloutPath: () => Promise<string | null>,
): CodexSkillTextSource {
  let injected: Promise<Map<string, string[]>> | null = null;
  return {
    async read(skill) {
      injected ??= readRolloutPath()
        .then((rolloutPath) =>
          rolloutPath ? readInjectedSkillTexts(rolloutPath) : new Map<string, string[]>(),
        )
        .catch(() => new Map<string, string[]>());
      const text = (await injected).get(skill.path)?.shift();
      return text ?? (await readSkillFile(skill.path));
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
  content: unknown;
  source: CodexSkillTextSource;
}): Promise<ToolCallTimelineItem[]> {
  const calls: ToolCallTimelineItem[] = [];
  // Sequential, so a history source hands out each skill's injections in order.
  for (const [index, skill] of readSkillInputs(input.content).entries()) {
    const base = {
      type: "tool_call" as const,
      callId: `codex-skill:${input.messageId ?? skill.path}:${index}`,
      name: "Skill",
    };
    const directory = `Base directory for this skill: ${path.dirname(skill.path)}`;
    try {
      const text = stripFrontMatter(await input.source.read(skill));
      calls.push({
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      calls.push({
        ...base,
        status: "failed",
        error: { message: `Paseo could not read ${skill.path}: ${message}` },
        detail: { type: "plain_text", label: skill.name, icon: "sparkles" },
      });
    }
  }
  return calls;
}
