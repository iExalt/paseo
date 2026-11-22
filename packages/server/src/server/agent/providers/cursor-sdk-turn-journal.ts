import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AgentTimelineItemPayloadSchema,
  AgentUsageSchema,
  CursorSkillReferenceSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeFileAtomic, writeJsonFileAtomic } from "../../atomic-file.js";
import type { AgentPromptInput, AgentTimelineItem } from "../agent-sdk-types.js";
import { executionOwnerSchema } from "../execution-owner/execution-owner.js";

const userMessageSchema = z.object({
  type: z.literal("user_message"),
  text: z.string(),
  messageId: z.string(),
  clientMessageId: z.string().optional(),
  cursorSkills: z.array(CursorSkillReferenceSchema).optional(),
});

const turnSchema = z.object({
  id: z.string().min(1),
  compact: z.literal(true).optional(),
  createdAt: z.string(),
  nativeRunId: z.string().optional(),
  executionOwner: executionOwnerSchema.optional(),
  executionIntent: z.uuid().optional(),
  executionRunIds: z.array(z.string()).optional(),
  followUpIds: z.array(z.string()).optional(),
  unresolvedNativeFollowUp: z.boolean().optional(),
  joined: z.boolean().optional(),
  recovered: z.boolean().optional(),
  ownerStopPending: z.boolean().optional(),
  lastUsage: AgentUsageSchema.optional(),
  user: userMessageSchema,
  steers: z.array(
    z.object({
      user: userMessageSchema,
      // Number of native timeline events consumed at ownership transfer.
      after: z.number().int().nonnegative(),
    }),
  ),
  terminal: z
    .discriminatedUnion("status", [
      z.object({ status: z.literal("finished"), fallback: z.string().optional() }),
      z.object({ status: z.literal("cancelled") }),
      z.object({
        status: z.literal("error"),
        message: z.string(),
        code: z.string().optional(),
      }),
    ])
    .optional(),
});

export type CursorHistoryTurn = z.infer<typeof turnSchema>;
export type CursorHistoryUser = z.infer<typeof userMessageSchema>;

function fileKey(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function syncPath(path: string): Promise<void> {
  // Windows FlushFileBuffers requires a writable file handle.
  const file = await open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Paseo owns the submitted text and identity. Cursor may omit both from canceled runs. */
export class CursorTurnJournal {
  private readonly directory: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(path: string, agentId: string) {
    this.directory = join(path, "paseo-turns", fileKey(agentId));
  }

  async admit(turn: CursorHistoryTurn, input: AgentPromptInput): Promise<void> {
    await this.saveInput(turn.id, turn.user.messageId, input);
    await this.save(turn);
  }

  async saveInput(turnId: string, messageId: string, input: AgentPromptInput): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Retain structured attachment refs and image content independently of the model's echo.
    await writeJsonFileAtomic(this.inputPath(turnId, messageId), input);
  }

  private inputPath(turnId: string, messageId: string): string {
    return join(this.directory, `${fileKey(turnId)}-${fileKey(messageId)}.input.json`);
  }

  async enrollExecutionOwner(turn: CursorHistoryTurn): Promise<void> {
    await syncPath(this.inputPath(turn.id, turn.user.messageId));
    await this.save(turn);
    if (process.platform === "win32") return;
    const parent = dirname(this.directory);
    await syncPath(parent);
    await syncPath(dirname(parent));
  }

  async save(turn: CursorHistoryTurn): Promise<void> {
    const data = JSON.stringify(turn);
    const file = join(this.directory, `${fileKey(turn.id)}.turn.json`);
    const durable = turn.executionOwner !== undefined || turn.executionIntent !== undefined;
    await this.write(turn.id, async () => {
      await writeFileAtomic(file, data);
      if (durable) {
        await syncPath(file);
        if (process.platform !== "win32") await syncPath(this.directory);
      }
    });
  }

  async append(turnId: string, item: AgentTimelineItem): Promise<void> {
    const line = JSON.stringify(item) + "\n";
    await this.write(turnId, () =>
      appendFile(join(this.directory, `${fileKey(turnId)}.items.ndjson`), line),
    );
  }

  async readItems(turnId: string): Promise<AgentTimelineItem[]> {
    let data: string;
    try {
      data = await readFile(join(this.directory, `${fileKey(turnId)}.items.ndjson`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // A daemon killed during append can leave an incomplete final record.
    return data
      .split("\n")
      .slice(0, -1)
      .map((line) => AgentTimelineItemPayloadSchema.parse(JSON.parse(line)));
  }

  private async write(turnId: string, operation: () => Promise<void>): Promise<void> {
    const pending = this.writes.get(turnId);
    const next = (pending?.catch(() => {}) ?? Promise.resolve()).then(operation);
    this.writes.set(turnId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(turnId) === next) this.writes.delete(turnId);
    }
  }

  async read(): Promise<CursorHistoryTurn[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.turn\.json$/.test(name))
        .map(async (name) =>
          turnSchema.parse(JSON.parse(await readFile(join(this.directory, name), "utf8"))),
        ),
    );
    return records.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
}
