import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { AgentUsageSchema, type SpendSummary } from "@getpaseo/protocol/messages";

const HEADER_SCHEMA = z.object({ startedAt: z.string() });
const ENTRY_SCHEMA = z.object({
  at: z.string(),
  provider: z.string(),
  agentId: z.string(),
  usd: z.number(),
  /** The session's lifetime cost after this entry, which the next reading is measured from. */
  totalUsd: z.number().nonnegative().optional(),
  turnId: z.string().optional(),
  usage: AgentUsageSchema.optional(),
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
  totalUsd?: number;
  turnId?: string;
  usage?: SpendEntry["usage"];
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
  const calendar = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(input.timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = calendar.format(input.now);
  const weekStart = daysBefore(today, 6);
  const byProvider = new Map<string, SpendSummary["providers"][number]>();
  // A turn can first report tokens and supply a price later.
  const priced = new Set(
    input.entries.filter((entry) => entry.turnId && entry.totalUsd !== undefined).map(runKey),
  );
  const counted = new Set<string>();
  for (const entry of input.entries) {
    const totals = byProvider.get(entry.provider) ?? {
      provider: entry.provider,
      todayUsd: 0,
      last7DaysUsd: 0,
      thisMonthUsd: 0,
      allTimeUsd: 0,
      carriedUsd: 0,
    };
    const day = calendar.format(new Date(entry.at));
    const inWeek = day >= weekStart && day <= today;
    const inMonth = day.slice(0, 7) === today.slice(0, 7);
    if (day === today) totals.todayUsd += entry.usd;
    if (inWeek) totals.last7DaysUsd += entry.usd;
    if (inMonth) totals.thisMonthUsd += entry.usd;
    totals.allTimeUsd += entry.usd;
    if (entry.carried) totals.carriedUsd += entry.usd;
    const key = runKey(entry);
    if (entry.turnId && !priced.has(key) && !counted.has(key)) {
      counted.add(key);
      const counts = (totals.unknownCostRuns ??= {
        today: 0,
        last7Days: 0,
        thisMonth: 0,
        allTime: 0,
      });
      if (day === today) counts.today++;
      if (inWeek) counts.last7Days++;
      if (inMonth) counts.thisMonth++;
      counts.allTime++;
    }
    byProvider.set(entry.provider, totals);
  }
  const providers = [...byProvider.values()].sort((a, b) => b.allTimeUsd - a.allTimeUsd);
  return { trackingSince: input.trackingSince, providers, totals: hostTotals(providers) };
}

function runKey(entry: Pick<SpendEntry, "agentId" | "turnId">): string {
  return JSON.stringify([entry.agentId, entry.turnId]);
}

function hostTotals(providers: SpendSummary["providers"]) {
  const totals = {
    todayUsd: 0,
    last7DaysUsd: 0,
    thisMonthUsd: 0,
    allTimeUsd: 0,
    carriedUsd: 0,
    unknownCostRuns: { today: 0, last7Days: 0, thisMonth: 0, allTime: 0 },
  };
  for (const provider of providers) {
    for (const period of [
      "todayUsd",
      "last7DaysUsd",
      "thisMonthUsd",
      "allTimeUsd",
      "carriedUsd",
    ] as const)
      totals[period] += provider[period];
    for (const period of ["today", "last7Days", "thisMonth", "allTime"] as const)
      totals.unknownCostRuns[period] += provider.unknownCostRuns?.[period] ?? 0;
  }
  return totals;
}

/**
 * An append-only record of what each agent spent and when, kept in `<paseoHome>/spend/ledger.jsonl`.
 * Providers only report a session's lifetime cost, so each increase becomes one dated entry.
 */
export class SpendLedger {
  private readonly filePath: string;
  private entries: SpendEntry[] = [];
  private readonly latestByRun = new Map<string, SpendEntry>();
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
      /** Pre-upgrade turns with an authoritative identity, timestamp and token report. */
      historicalRuns?: () => AsyncIterable<
        Pick<SpendEntry, "agentId" | "provider" | "turnId" | "usage" | "at">
      >;
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
    this.entries = [];
    this.lastTotalByAgent.clear();
    this.latestByRun.clear();
    this.startedAt = null;
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.create();
      await this.tryImportHistoricalRuns();
      return;
    }
    this.endsMidLine = text.length > 0 && !text.endsWith("\n");
    let imported = false;
    for (const line of text.split("\n")) {
      const value = parseLine(line);
      if (
        value &&
        typeof value === "object" &&
        "cursorUsageImported" in value &&
        value.cursorUsageImported === true
      )
        imported = true;
      const entry = ENTRY_SCHEMA.safeParse(value);
      if (entry.success) this.add(entry.data);
      this.startedAt ??= HEADER_SCHEMA.safeParse(value).data?.startedAt ?? null;
    }
    if (!imported) await this.tryImportHistoricalRuns();
  }

  private async tryImportHistoricalRuns(): Promise<void> {
    try {
      await this.importHistoricalRuns();
    } catch (err) {
      // Keep accepting live runs. Without the marker, the next startup retries
      // any missing history and skips the identities already imported.
      this.options.logger.warn({ err }, "Could not finish importing historical Cursor usage");
    }
  }

  private async importHistoricalRuns(): Promise<void> {
    if (!this.options.historicalRuns) return;
    for await (const run of this.options.historicalRuns()) {
      if (!run.turnId || this.latestByRun.has(runKey(run))) continue;
      await this.writeEntry({ ...run, usd: 0 });
    }
    await fs.appendFile(
      this.filePath,
      (this.endsMidLine ? "\n" : "") + '{"cursorUsageImported":true}\n',
    );
    this.endsMidLine = false;
  }

  private async create(): Promise<void> {
    const startedAt = this.now().toISOString();
    const seeds = (await this.options.seed?.()) ?? [];
    const entries = seeds
      .filter((seed) => seed.usd >= 0)
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
    if (entry.totalUsd !== undefined) this.lastTotalByAgent.set(entry.agentId, entry.totalUsd);
    if (entry.turnId) {
      const key = runKey(entry);
      const previous = this.latestByRun.get(key);
      this.latestByRun.set(key, {
        ...entry,
        at: previous?.at ?? entry.at,
        totalUsd: entry.totalUsd ?? previous?.totalUsd,
      });
    }
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
    const previous = this.latestByRun.get(runKey(reading));
    const totalUsd = reading.totalUsd;
    if (totalUsd !== undefined && (!Number.isFinite(totalUsd) || totalUsd < 0)) return;
    const usage = reading.usage ?? previous?.usage;
    // A token correction for an already priced turn must not reapply its old
    // lifetime total after a later turn has advanced the session baseline.
    const newCost = totalUsd !== undefined && previous?.totalUsd !== totalUsd;
    const usd = newCost ? spendDelta(previousUsd, totalUsd) : 0;
    if (!reading.turnId && (totalUsd === undefined || previousUsd === totalUsd)) return;
    if (previous && !newCost && JSON.stringify(previous.usage) === JSON.stringify(usage)) return;
    const carried = previousUsd === undefined && this.predatesLedger(reading.createdAt);
    const entry: SpendEntry = {
      at: previous?.at ?? at,
      provider: reading.provider,
      agentId: reading.agentId,
      usd,
      totalUsd: newCost ? totalUsd : undefined,
      turnId: reading.turnId,
      usage,
      ...(carried ? { carried } : {}),
    };
    await this.writeEntry(entry);
  }

  private predatesLedger(createdAt: Date): boolean {
    return this.startedAt !== null && createdAt.getTime() < Date.parse(this.startedAt);
  }

  private async writeEntry(entry: SpendEntry): Promise<void> {
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
