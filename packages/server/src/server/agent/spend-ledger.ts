import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { SpendSummary } from "@getpaseo/protocol/messages";

const HEADER_SCHEMA = z.object({ startedAt: z.string() });
const ENTRY_SCHEMA = z.object({
  at: z.string(),
  provider: z.string(),
  agentId: z.string(),
  usd: z.number(),
  /** The session's lifetime cost after this entry, which the next reading is measured from. */
  totalUsd: z.number(),
  /** Spent before tracking began, counted when the session first reported it. */
  carried: z.boolean().optional(),
});
type SpendEntry = z.infer<typeof ENTRY_SCHEMA>;

/** A stored agent's last known session cost, which seeds a new ledger. */
export interface SpendSeed {
  agentId: string;
  provider: string;
  usd: number;
  at: string;
}

/** A provider's lifetime cost report for one agent's session. */
export interface SpendReading {
  agentId: string;
  provider: string;
  createdAt: Date;
  totalUsd: number;
}

/**
 * The money spent between two lifetime cost readings. A lower reading means the provider started
 * a new count (a new session behind the same agent), so all of it is new spend.
 */
export function spendDelta(previousUsd: number | undefined, currentUsd: number): number {
  if (!Number.isFinite(currentUsd) || currentUsd <= 0) return 0;
  if (previousUsd === undefined || currentUsd < previousUsd) return currentUsd;
  return currentUsd - previousUsd;
}

/** A ledger line, or null for a blank line or one cut short by a crash. */
function parseLine(line: string): unknown {
  if (line.trim().length === 0) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function dateKey(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function resolveTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function daysBefore(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - days)).toISOString().slice(0, 10);
}

/** Totals per provider for today, the last seven days and this month, in the caller's time zone. */
export function summarizeSpend(input: {
  entries: readonly SpendEntry[];
  trackingSince: string | null;
  now: Date;
  timeZone?: string;
}): SpendSummary {
  const timeZone = resolveTimeZone(input.timeZone);
  const today = dateKey(input.now, timeZone);
  const weekStart = daysBefore(today, 6);
  const month = today.slice(0, 7);
  const byProvider = new Map<string, SpendSummary["providers"][number]>();
  for (const entry of input.entries) {
    const totals = byProvider.get(entry.provider) ?? {
      provider: entry.provider,
      todayUsd: 0,
      last7DaysUsd: 0,
      thisMonthUsd: 0,
      allTimeUsd: 0,
      carriedUsd: 0,
    };
    const key = dateKey(new Date(entry.at), timeZone);
    if (key === today) totals.todayUsd += entry.usd;
    if (key >= weekStart && key <= today) totals.last7DaysUsd += entry.usd;
    if (key.slice(0, 7) === month) totals.thisMonthUsd += entry.usd;
    totals.allTimeUsd += entry.usd;
    if (entry.carried) totals.carriedUsd += entry.usd;
    byProvider.set(entry.provider, totals);
  }
  return {
    trackingSince: input.trackingSince,
    providers: [...byProvider.values()].sort((a, b) => b.allTimeUsd - a.allTimeUsd),
  };
}

/**
 * An append-only record of what each agent spent and when, kept in `<paseoHome>/spend/ledger.jsonl`.
 * Providers only report a session's lifetime cost, so each increase becomes one dated entry.
 */
export class SpendLedger {
  private readonly filePath: string;
  private entries: SpendEntry[] = [];
  private readonly lastTotalByAgent = new Map<string, number>();
  private startedAt: string | null = null;
  /** A crash mid-append leaves a last line with no newline; the next entry must not join it. */
  private endsMidLine = false;
  private loaded: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      paseoHome: string;
      logger: Logger;
      /** Stored session costs; a new ledger counts them as carried in. */
      seed?: () => Promise<SpendSeed[]>;
      now?: () => Date;
    },
  ) {
    this.filePath = path.join(options.paseoHome, "spend", "ledger.jsonl");
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Reads the ledger, or starts one. Call it at startup: sessions created before the ledger starts
   * count their first reading as carried in.
   */
  initialize(): Promise<void> {
    this.loaded ??= this.readOrCreate().catch((error: unknown) => {
      // The next record or summary tries again.
      this.loaded = null;
      throw error;
    });
    return this.loaded;
  }

  private async readOrCreate(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.create();
      return;
    }
    this.endsMidLine = text.length > 0 && !text.endsWith("\n");
    for (const line of text.split("\n")) {
      const value = parseLine(line);
      const entry = ENTRY_SCHEMA.safeParse(value);
      if (entry.success) this.add(entry.data);
      this.startedAt ??= HEADER_SCHEMA.safeParse(value).data?.startedAt ?? null;
    }
  }

  private async create(): Promise<void> {
    const startedAt = this.now().toISOString();
    const seeds = (await this.options.seed?.()) ?? [];
    const entries = seeds
      .filter((seed) => seed.usd > 0)
      .map((seed): SpendEntry => ({
        at: seed.at,
        provider: seed.provider,
        agentId: seed.agentId,
        usd: seed.usd,
        totalUsd: seed.usd,
        carried: true,
      }));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const lines = [JSON.stringify({ startedAt }), ...entries.map((entry) => JSON.stringify(entry))];
    // Written whole, so a crash never leaves a ledger without its start or with half the seeds.
    const partialPath = `${this.filePath}.partial`;
    await fs.writeFile(partialPath, `${lines.join("\n")}\n`);
    await fs.rename(partialPath, this.filePath);
    this.startedAt = startedAt;
    for (const entry of entries) this.add(entry);
  }

  private add(entry: SpendEntry): void {
    this.entries.push(entry);
    this.lastTotalByAgent.set(entry.agentId, entry.totalUsd);
  }

  /**
   * Records what an agent spent since its last reading. The ledger keeps each agent's last reading
   * itself, so a reading repeated after a daemon restart adds nothing.
   */
  record(reading: SpendReading): Promise<void> {
    const at = this.now().toISOString();
    this.tail = this.tail
      .then(() => this.append(reading, at))
      .catch((err: unknown) => {
        this.options.logger.warn({ err, agentId: reading.agentId }, "Failed to record spend");
      });
    return this.tail;
  }

  private async append(reading: SpendReading, at: string): Promise<void> {
    await this.initialize();
    const previousUsd = this.lastTotalByAgent.get(reading.agentId);
    const usd = spendDelta(previousUsd, reading.totalUsd);
    if (usd <= 0) return;
    // A session from before tracking began reports everything it ever spent in its first
    // reading; flag that so totals can say part of it is older.
    const carried =
      previousUsd === undefined &&
      this.startedAt !== null &&
      reading.createdAt.getTime() < Date.parse(this.startedAt);
    const entry: SpendEntry = {
      at,
      provider: reading.provider,
      agentId: reading.agentId,
      usd,
      totalUsd: reading.totalUsd,
      ...(carried ? { carried } : {}),
    };
    const line = `${this.endsMidLine ? "\n" : ""}${JSON.stringify(entry)}\n`;
    await fs.appendFile(this.filePath, line);
    this.endsMidLine = false;
    this.add(entry);
  }

  async summarize(timeZone?: string): Promise<SpendSummary> {
    await this.tail;
    await this.initialize();
    return summarizeSpend({
      entries: this.entries,
      trackingSince: this.startedAt,
      now: this.now(),
      timeZone,
    });
  }
}
