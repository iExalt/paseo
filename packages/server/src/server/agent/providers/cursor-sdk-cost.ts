import type { LocalAgentRunDocument } from "@cursor/sdk";
import type { Logger } from "pino";
import { z } from "zod";
import { cursorSdkBackendUrl } from "./cursor-sdk-auth.js";

const REQUEST_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const WINDOW_PAD_MS = 60_000;
const CLUSTER_GAP_MS = 5 * 60_000;
const HISTORICAL_SETTLE_AGE_MS = 2 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_WINDOW = 10;

/** Billing lags run completion; give up after ~2 minutes of retries. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
/** In-place subagent/trailing updates require one confirmation re-poll before settling. */
const DEFAULT_CONFIRM_DELAY_MS = 2_500;
const RECENT_RUN_WINDOW_MS = 5_000;
const MAX_CONFIRM_POLLS = 8;

const ExchangeResponseSchema = z.object({
  accessToken: z.string().min(1),
});

const CursorTokenUsageSchema = z.object({
  inputTokens: z.coerce.number().finite().nonnegative().optional(),
  outputTokens: z.coerce.number().finite().nonnegative().optional(),
  cacheReadTokens: z.coerce.number().finite().nonnegative().optional(),
  cacheWriteTokens: z.coerce.number().finite().nonnegative().optional(),
  totalCents: z.coerce.number().finite().nonnegative().optional(),
});

const CursorUsageEventDisplaySchema = z.object({
  usageEventId: z.string().min(1).optional(),
  timestamp: z.coerce.number().finite().optional(),
  conversationId: z.string().optional(),
  chargedCents: z.coerce.number().finite().nonnegative().optional(),
  tokenUsage: CursorTokenUsageSchema.optional(),
});

const GetFilteredUsageEventsResponseSchema = z.object({
  usageEventsDisplay: z.array(CursorUsageEventDisplaySchema).optional(),
  totalUsageEventsCount: z.coerce.number().finite().nonnegative().optional(),
});

export interface MatchedCursorUsageEvent {
  eventId: string;
  conversationId: string;
  timestampMs?: number;
  cents?: number;
  accountedTokens: number;
}

export interface CursorUsageWindowResult {
  events: MatchedCursorUsageEvent[];
  complete: boolean;
}

export interface CursorUsageWindow {
  key: string;
  startMs: number;
  endMs: number;
  allTerminal: boolean;
}

export interface CursorUsageQueryPlan {
  windows: CursorUsageWindow[];
  reportedTokens: number;
  startedRunCount: number;
  latestRunStartedAtMs?: number;
  recentRunCount: number;
}

/**
 * Selects the reported USD cents for one Cursor usage event: prefer `chargedCents`
 * when positive (matching Cursor's dashboard and billed/request-priced runs), falling
 * back to `tokenUsage.totalCents` when `chargedCents` is absent or zero.
 */
export function cursorUsageEventCents(event: {
  chargedCents?: number;
  tokenUsage?: { totalCents?: number };
}): number | undefined {
  if (
    event.chargedCents !== undefined &&
    Number.isFinite(event.chargedCents) &&
    event.chargedCents > 0
  ) {
    return event.chargedCents;
  }
  const raw = event.tokenUsage?.totalCents;
  if (raw !== undefined && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return undefined;
}

function accountedTokensOf(usage: z.infer<typeof CursorTokenUsageSchema> | undefined): number {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
}

export interface CursorDashboardUsageFetcher {
  fetchWindow(params: {
    apiKey: string;
    startMs: number;
    endMs: number;
    conversationIds: ReadonlySet<string>;
    signal?: AbortSignal;
  }): Promise<CursorUsageWindowResult>;
}

/**
 * Fetches caller-scoped Cursor usage events via `DashboardService/GetFilteredUsageEvents`,
 * exchanging the SDK API key for a short-lived access token and caching it per `(backendUrl, apiKey)`.
 */
export class CursorDashboardUsageClient implements CursorDashboardUsageFetcher {
  private readonly tokens = new Map<string, { token: string; expiresAtMs?: number }>();
  private readonly inflightExchanges = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchApi: typeof fetch = fetch,
    private readonly resolveBackendUrl: () => string = cursorSdkBackendUrl,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private cacheKey(backendUrl: string, apiKey: string): string {
    return `${backendUrl}\0${apiKey}`;
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async getAccessToken(
    backendUrl: string,
    apiKey: string,
    forceRefresh = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = this.cacheKey(backendUrl, apiKey);
    if (!forceRefresh) {
      const cached = this.tokens.get(key);
      if (
        cached &&
        (cached.expiresAtMs === undefined ||
          this.now() < cached.expiresAtMs - ACCESS_TOKEN_EXPIRY_SKEW_MS)
      ) {
        return cached.token;
      }
    } else {
      this.tokens.delete(key);
    }

    const existing = this.inflightExchanges.get(key);
    if (existing) return existing;

    const exchange = (async () => {
      const res = await this.fetchApi(`${backendUrl}/auth/exchange_user_api_key`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: this.requestSignal(signal),
      });
      if (!res.ok) {
        throw new Error(`Cursor token exchange returned HTTP ${res.status}`);
      }
      const { accessToken } = ExchangeResponseSchema.parse(await res.json());
      this.tokens.set(key, { token: accessToken, expiresAtMs: jwtExpiryMs(accessToken) });
      return accessToken;
    })();
    this.inflightExchanges.set(key, exchange);
    try {
      return await exchange;
    } finally {
      if (this.inflightExchanges.get(key) === exchange) this.inflightExchanges.delete(key);
    }
  }

  private async postFilteredEvents(
    backendUrl: string,
    apiKey: string,
    body: { startDate: string; endDate: string; page: number; pageSize: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof GetFilteredUsageEventsResponseSchema>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getAccessToken(backendUrl, apiKey, attempt > 0, signal);
      const res = await this.fetchApi(
        `${backendUrl}/aiserver.v1.DashboardService/GetFilteredUsageEvents`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
          },
          body: JSON.stringify(body),
          signal: this.requestSignal(signal),
        },
      );
      if (res.status === 401 && attempt === 0) {
        this.tokens.delete(this.cacheKey(backendUrl, apiKey));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Cursor usage events API returned HTTP ${res.status}`);
      }
      return GetFilteredUsageEventsResponseSchema.parse(await res.json());
    }
    throw new Error("Cursor usage events API rejected authentication");
  }

  async fetchWindow(params: {
    apiKey: string;
    startMs: number;
    endMs: number;
    conversationIds: ReadonlySet<string>;
    signal?: AbortSignal;
  }): Promise<CursorUsageWindowResult> {
    const backendUrl = this.resolveBackendUrl();
    const matched: MatchedCursorUsageEvent[] = [];
    let fetched = 0;
    let complete = true;

    for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page += 1) {
      const response = await this.postFilteredEvents(
        backendUrl,
        params.apiKey,
        {
          startDate: String(Math.max(0, Math.floor(params.startMs))),
          endDate: String(Math.max(0, Math.ceil(params.endMs))),
          page,
          pageSize: PAGE_SIZE,
        },
        params.signal,
      );
      const display = response.usageEventsDisplay ?? [];
      fetched += display.length;
      for (const entry of display) {
        if (!entry.conversationId || !params.conversationIds.has(entry.conversationId)) continue;
        const eventId =
          entry.usageEventId ?? `${entry.conversationId}:${entry.timestamp ?? "unknown"}`;
        matched.push({
          eventId,
          conversationId: entry.conversationId,
          timestampMs: entry.timestamp,
          cents: cursorUsageEventCents(entry),
          accountedTokens: accountedTokensOf(entry.tokenUsage),
        });
      }
      const total = response.totalUsageEventsCount;
      if (display.length < PAGE_SIZE || (total !== undefined && fetched >= total)) {
        break;
      }
      if (page === MAX_PAGES_PER_WINDOW) {
        complete = false;
      }
    }

    return { events: matched, complete };
  }
}

function isTerminalRunStatus(status: LocalAgentRunDocument["status"]): boolean {
  return status !== "queued" && status !== "running";
}

function runDedupKey(run: LocalAgentRunDocument): string {
  const req = run.requestId?.trim();
  if (req) return `req:${req}`;
  return `turn:${run.turnNumber}:${run.startedAt ?? run.createdAt}`;
}

/**
 * Deduplicates copied ancestor runs across a rewind fork lineage (`cursor-sdk-rewind.ts`
 * copies kept runs with the same `requestId`/`startedAt` under the new fork's `agentId`)
 * and builds compact coalesced query windows so multi-day chats never scan idle days.
 */
function dedupeCursorRuns(
  runs: readonly LocalAgentRunDocument[],
): Map<string, LocalAgentRunDocument> {
  const deduped = new Map<string, LocalAgentRunDocument>();
  for (const run of runs) {
    if (run.startedAt == null && run.usage == null) continue;
    const key = runDedupKey(run);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, run);
      continue;
    }
    const nextTokens = run.usage?.totalTokens ?? 0;
    const existingTokens = existing.usage?.totalTokens ?? 0;
    if (nextTokens > existingTokens || (run.endedAt ?? 0) > (existing.endedAt ?? 0)) {
      deduped.set(key, run);
    }
  }
  return deduped;
}

function coalesceCursorWindows(
  intervals: Array<{ startMs: number; endMs: number; terminal: boolean }>,
): CursorUsageWindow[] {
  intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const windows: CursorUsageWindow[] = [];
  for (const item of intervals) {
    const previous = windows.at(-1);
    if (previous && item.startMs <= previous.endMs + CLUSTER_GAP_MS) {
      previous.endMs = Math.max(previous.endMs, item.endMs);
      previous.allTerminal = previous.allTerminal && item.terminal;
      previous.key = `${previous.startMs}:${previous.endMs}`;
    } else {
      windows.push({
        key: `${item.startMs}:${item.endMs}`,
        startMs: item.startMs,
        endMs: item.endMs,
        allTerminal: item.terminal,
      });
    }
  }
  return windows;
}

export function buildCursorUsageQueryPlan(
  runs: readonly LocalAgentRunDocument[],
  nowMs: number,
): CursorUsageQueryPlan {
  const deduped = dedupeCursorRuns(runs);
  let reportedTokens = 0;
  const intervals: Array<{ startMs: number; endMs: number; terminal: boolean }> = [];
  for (const run of deduped.values()) {
    reportedTokens += run.usage?.totalTokens ?? 0;
    const start = run.startedAt ?? run.createdAt;
    const end = run.endedAt ?? Math.max(start, nowMs);
    intervals.push({
      startMs: Math.max(0, start - WINDOW_PAD_MS),
      endMs: Math.max(start, end) + WINDOW_PAD_MS,
      terminal: isTerminalRunStatus(run.status),
    });
  }
  let latestRunStartedAtMs: number | undefined;
  for (const run of deduped.values()) {
    const start = run.startedAt ?? run.createdAt;
    if (latestRunStartedAtMs === undefined || start > latestRunStartedAtMs) {
      latestRunStartedAtMs = start;
    }
  }
  let recentRunCount = 0;
  if (latestRunStartedAtMs !== undefined) {
    const cutoff = latestRunStartedAtMs - RECENT_RUN_WINDOW_MS;
    for (const run of deduped.values()) {
      if ((run.startedAt ?? run.createdAt) >= cutoff) recentRunCount += 1;
    }
  }
  return {
    windows: coalesceCursorWindows(intervals),
    reportedTokens,
    startedRunCount: deduped.size,
    latestRunStartedAtMs,
    recentRunCount,
  };
}

export interface CursorSessionCostOptions {
  resumed: boolean;
  readLineage: () => Promise<string[]>;
  readRuns: (agentId: string) => Promise<LocalAgentRunDocument[]>;
  readApiKey: () => Promise<string>;
  fetcher: CursorDashboardUsageFetcher;
  publish: (totalCostUsd: number, turnId?: string) => void;
  logger?: Logger;
  retryDelaysMs?: readonly number[];
  confirmDelayMs?: number;
  now?: () => number;
}

/**
 * Tracks the monotonic USD cost of a Cursor SDK chat (including server-rolled-up
 * `Task` subagents and conversation-rewind fork ancestors) via `DashboardService`.
 */
export class CursorSessionCost {
  private readonly eventsById = new Map<
    string,
    { cents: number; accountedTokens: number; timestampMs?: number }
  >();
  private readonly settledWindows = new Set<string>();
  private readonly pendingTurnIds: string[] = [];
  private publishedCents: number | null = null;
  private confirmedSignature: string | null = null;
  private awaitingConfirmation = false;
  private confirmAttempts = 0;
  private generation = 0;
  private attempt = 0;
  private running = false;
  private rerun = false;
  private disposed = false;
  private readonly abortController = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private readonly retryDelaysMs: readonly number[];
  private readonly confirmDelayMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CursorSessionCostOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.confirmDelayMs = options.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS;
    this.now = options.now ?? (() => Date.now());
  }

  refresh(completedTurnId?: string): void {
    if (this.disposed) return;
    if (completedTurnId && !this.pendingTurnIds.includes(completedTurnId)) {
      this.pendingTurnIds.push(completedTurnId);
    }
    this.attempt = 0;
    this.awaitingConfirmation = false;
    this.confirmedSignature = null;
    this.confirmAttempts = 0;
    if (this.running) {
      this.rerun = true;
      this.wake?.();
      return;
    }
    void this.run(this.generation);
  }

  /** Rewind adds a new fork agent ID; re-check lineage without dropping published cost. */
  onRewind(): void {
    if (this.disposed) return;
    this.settledWindows.clear();
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abortController.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
    this.wake = null;
    this.running = false;
    this.rerun = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
        resolve();
      };
      this.wake = done;
      this.timer = setTimeout(done, ms);
      this.timer.unref();
    });
  }

  private totals(): { totalCents: number; accountedTokens: number; pricedEventCount: number } {
    let totalCents = 0;
    let accountedTokens = 0;
    let pricedEventCount = 0;
    for (const entry of this.eventsById.values()) {
      if (entry.cents > 0) {
        totalCents += entry.cents;
        pricedEventCount += 1;
      }
      accountedTokens += entry.accountedTokens;
    }
    return { totalCents, accountedTokens, pricedEventCount };
  }

  private mergeEvents(events: readonly MatchedCursorUsageEvent[]): void {
    for (const event of events) {
      const previous = this.eventsById.get(event.eventId);
      const nextCents = Math.max(previous?.cents ?? 0, event.cents ?? 0);
      const nextTokens = Math.max(previous?.accountedTokens ?? 0, event.accountedTokens);
      const timestampMs = event.timestampMs ?? previous?.timestampMs;
      this.eventsById.set(event.eventId, {
        cents: nextCents,
        accountedTokens: nextTokens,
        timestampMs,
      });
    }
  }

  private hasRecentTurnCoverage(result: {
    startedRunCount: number;
    latestRunStartedAtMs?: number;
    recentRunCount: number;
  }): boolean {
    if (this.pendingTurnIds.length === 0 || result.latestRunStartedAtMs === undefined) {
      return true;
    }
    let pricedCount = 0;
    let timestampedPricedCount = 0;
    let recentPricedCount = 0;
    const cutoff = result.latestRunStartedAtMs - RECENT_RUN_WINDOW_MS;
    for (const entry of this.eventsById.values()) {
      if (entry.cents <= 0) continue;
      pricedCount += 1;
      if (entry.timestampMs !== undefined) {
        timestampedPricedCount += 1;
        if (entry.timestampMs >= cutoff) recentPricedCount += 1;
      }
    }
    if (timestampedPricedCount > 0) {
      return recentPricedCount >= result.recentRunCount;
    }
    return pricedCount >= result.startedRunCount;
  }

  private publishIntermediate(totalCents: number, allComplete: boolean): void {
    if (totalCents <= 0) return;
    if (this.options.resumed && this.publishedCents === null && !allComplete) return;
    if (this.publishedCents !== null && totalCents <= this.publishedCents) return;
    this.publishedCents = totalCents;
    this.options.publish(totalCents / 100);
  }

  private publishSettled(totalCents: number): void {
    if (totalCents <= 0) return;
    const usd = totalCents / 100;
    const pending = this.pendingTurnIds.splice(0);
    if (pending.length > 0) {
      this.publishedCents = Math.max(this.publishedCents ?? 0, totalCents);
      for (const turnId of pending) {
        this.options.publish(usd, turnId);
      }
      return;
    }
    if (this.publishedCents === null || totalCents > this.publishedCents) {
      this.publishedCents = totalCents;
      this.options.publish(usd);
    }
  }

  private async pollOnce(generation: number): Promise<{
    allComplete: boolean;
    startedRunCount: number;
    reportedTokens: number;
    latestRunStartedAtMs?: number;
    recentRunCount: number;
    error?: unknown;
  }> {
    let lineage: string[];
    let runs: LocalAgentRunDocument[];
    let apiKey: string;
    try {
      lineage = await this.options.readLineage();
      const perAgent = await Promise.all(lineage.map((id) => this.options.readRuns(id)));
      runs = perAgent.flat();
      apiKey = await this.options.readApiKey();
    } catch (error) {
      return {
        allComplete: false,
        startedRunCount: 0,
        reportedTokens: 0,
        recentRunCount: 0,
        error,
      };
    }
    if (generation !== this.generation) {
      return { allComplete: false, startedRunCount: 0, reportedTokens: 0, recentRunCount: 0 };
    }

    const nowMs = this.now();
    const plan = buildCursorUsageQueryPlan(runs, nowMs);
    if (plan.windows.length === 0) {
      return { allComplete: true, startedRunCount: 0, reportedTokens: 0, recentRunCount: 0 };
    }

    const conversationIds = new Set(lineage);
    let allComplete = true;
    for (const window of plan.windows) {
      if (generation !== this.generation) {
        return {
          allComplete: false,
          startedRunCount: plan.startedRunCount,
          reportedTokens: plan.reportedTokens,
          latestRunStartedAtMs: plan.latestRunStartedAtMs,
          recentRunCount: plan.recentRunCount,
        };
      }
      if (this.settledWindows.has(window.key)) continue;
      try {
        const result = await this.options.fetcher.fetchWindow({
          apiKey,
          startMs: window.startMs,
          endMs: window.endMs,
          conversationIds,
          signal: this.abortController.signal,
        });
        if (generation !== this.generation) {
          return {
            allComplete: false,
            startedRunCount: plan.startedRunCount,
            reportedTokens: plan.reportedTokens,
            latestRunStartedAtMs: plan.latestRunStartedAtMs,
            recentRunCount: plan.recentRunCount,
          };
        }
        this.mergeEvents(result.events);
        if (!result.complete) {
          allComplete = false;
        } else if (
          window.allTerminal &&
          result.events.length > 0 &&
          nowMs - window.endMs >= HISTORICAL_SETTLE_AGE_MS
        ) {
          this.settledWindows.add(window.key);
        }
      } catch (error) {
        allComplete = false;
        this.options.logger?.debug(
          { err: error, windowKey: window.key },
          "Failed to fetch Cursor usage events window",
        );
      }
    }

    return {
      allComplete,
      startedRunCount: plan.startedRunCount,
      reportedTokens: plan.reportedTokens,
      latestRunStartedAtMs: plan.latestRunStartedAtMs,
      recentRunCount: plan.recentRunCount,
    };
  }

  private handleCoveredPoll(
    totalCents: number,
    accountedTokens: number,
    allComplete: boolean,
  ): "done" | "immediate" | number {
    const signature = `${totalCents}:${accountedTokens}:${this.eventsById.size}`;
    const needsConfirm = this.pendingTurnIds.length > 0 && !this.awaitingConfirmation;
    const settled =
      !needsConfirm && (this.pendingTurnIds.length === 0 || signature === this.confirmedSignature);
    if (settled) {
      this.awaitingConfirmation = false;
      this.confirmedSignature = null;
      this.confirmAttempts = 0;
      this.publishSettled(totalCents);
      return this.rerun ? "immediate" : "done";
    }
    this.publishIntermediate(totalCents, allComplete);
    if (this.confirmAttempts >= MAX_CONFIRM_POLLS) {
      this.awaitingConfirmation = false;
      this.confirmedSignature = null;
      this.confirmAttempts = 0;
      this.options.logger?.warn(
        { totalCents, accountedTokens },
        "Cursor chat cost kept changing past confirmation limit",
      );
      return "done";
    }
    this.awaitingConfirmation = true;
    this.confirmedSignature = signature;
    this.confirmAttempts += 1;
    return this.rerun ? "immediate" : this.confirmDelayMs;
  }

  /** Evaluates one poll result and returns the next wait delay, `"done"`, or `"immediate"`. */
  private decideNextStep(result: {
    allComplete: boolean;
    startedRunCount: number;
    reportedTokens: number;
    latestRunStartedAtMs?: number;
    recentRunCount: number;
    error?: unknown;
  }): "done" | "immediate" | number {
    if (result.startedRunCount === 0 && !result.error) return "done";
    const { totalCents, accountedTokens, pricedEventCount } = this.totals();
    const covered =
      result.allComplete &&
      pricedEventCount > 0 &&
      this.hasRecentTurnCoverage(result) &&
      (result.reportedTokens === 0 || accountedTokens >= result.reportedTokens);

    if (covered) {
      return this.handleCoveredPoll(totalCents, accountedTokens, result.allComplete);
    }

    this.awaitingConfirmation = false;
    this.confirmedSignature = null;
    this.confirmAttempts = 0;
    this.publishIntermediate(totalCents, result.allComplete);
    if (this.rerun) return "immediate";
    const delay = this.retryDelaysMs[this.attempt];
    if (delay === undefined) {
      this.options.logger?.warn(
        {
          reportedTokens: result.reportedTokens,
          accountedTokens,
          allComplete: result.allComplete,
        },
        "Cursor chat cost accounting did not settle before retry limit",
      );
      return "done";
    }
    this.attempt += 1;
    return delay;
  }

  private async run(generation: number): Promise<void> {
    this.running = true;
    try {
      while (generation === this.generation && !this.disposed) {
        this.rerun = false;
        const result = await this.pollOnce(generation);
        if (generation !== this.generation || this.disposed) return;
        const next = this.decideNextStep(result);
        if (next === "done") return;
        if (typeof next === "number") await this.sleep(next);
      }
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }
}
