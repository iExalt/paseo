import type { Logger } from "pino";
import { z } from "zod";

// `account/usage/read` with a thread ID (seen in Codex 0.163). Builds without it reject the
// request, and the cost stays unknown. A thread Codex has not accounted yet reads as 0 USD with
// no groups, which is indistinguishable from an unknown thread ID.
const CodexThreadUsageResponseSchema = z.object({
  threadUsage: z
    .object({
      estimatedUsageUsdMicros: z.number().nonnegative().nullable().optional(),
      groups: z
        .array(z.object({ totalTokens: z.number().nonnegative().nullable().optional() }))
        .optional(),
    })
    .nullable()
    .optional(),
});

/** Accounting lags turn completion; give up on a thread about two minutes after the trigger. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
const MAX_CONCURRENT_READS = 4;

type ThreadCostState =
  /** Not read yet, or every read so far failed or came back before accounting started. */
  | { status: "unknown" }
  /** Codex has no USD price for this thread's billing route. */
  | { status: "unpriced" }
  /** A reading that covers fewer tokens than the thread has reported using. */
  | { status: "lagging"; usdMicros: number }
  | { status: "settled"; usdMicros: number };

export interface CodexThreadCostOptions {
  readUsage: (threadId: string) => Promise<unknown>;
  publish: (totalCostUsd: number) => void;
  logger: Logger;
}

/**
 * The USD cost of a Codex chat: its root thread plus every native subagent thread it spawned,
 * directly or through another subagent. Codex prices each thread separately, so the total is
 * their sum. Threads a subagent tool only messaged or waited on are not counted unless a spawn
 * in this tree created them.
 *
 * The published total never falls within a root thread: readings only rise, and a session
 * resumed from disk publishes nothing until every known thread has a reading, because its stored
 * total already includes them and the spend ledger treats a lower total as a new session.
 */
export class CodexThreadCost {
  private rootThreadId: string | null = null;
  private resumed = false;
  private discoveryComplete = true;
  private readonly threads = new Map<string, ThreadCostState>();
  /**
   * Each thread's cumulative token total from `thread/tokenUsage/updated`. A child can report
   * before the spawn that names it completes, so this keeps threads not yet known to be ours.
   */
  private readonly reportedTokens = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private publishedUsdMicros: number | null = null;
  private generation = 0;
  private attempt = 0;
  private running = false;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private readonly warnedThreadIds = new Set<string>();

  constructor(private readonly options: CodexThreadCostOptions) {}

  /** Starts counting a new root thread, dropping readings and work for the previous one. */
  reset(rootThreadId: string | null, params: { resumed: boolean }): void {
    if (rootThreadId === this.rootThreadId && rootThreadId !== null) return;
    this.cancel();
    this.rootThreadId = rootThreadId;
    this.resumed = params.resumed;
    this.discoveryComplete = true;
    this.threads.clear();
    this.reportedTokens.clear();
    this.dirty.clear();
    this.warnedThreadIds.clear();
    this.publishedUsdMicros = null;
    if (rootThreadId) this.threads.set(rootThreadId, { status: "unknown" });
  }

  dispose(): void {
    this.cancel();
    this.rootThreadId = null;
    this.threads.clear();
    this.reportedTokens.clear();
    this.dirty.clear();
  }

  /** Counts threads that `sourceThreadId` spawned, when the source is this root or its descendant. */
  addSpawnedThreads(
    sourceThreadId: string | null | undefined,
    childThreadIds: readonly string[],
  ): void {
    const root = this.rootThreadId;
    if (!root || childThreadIds.length === 0) return;
    const source = sourceThreadId ?? root;
    if (!this.threads.has(source)) return;
    for (const childThreadId of childThreadIds) {
      if (childThreadId.length > 0 && !this.threads.has(childThreadId)) {
        this.threads.set(childThreadId, { status: "unknown" });
      }
    }
  }

  /** History discovery stopped before visiting every descendant, so the tree may be larger. */
  markDiscoveryIncomplete(): void {
    this.discoveryComplete = false;
  }

  reportTokens(threadId: string | null, totalTokens: number): void {
    const key = threadId ?? this.rootThreadId;
    if (!key || !Number.isFinite(totalTokens)) return;
    const previous = this.reportedTokens.get(key) ?? 0;
    if (totalTokens <= previous) return;
    this.reportedTokens.set(key, totalTokens);
    const state = this.threads.get(key);
    if (state?.status === "settled") {
      this.threads.set(key, { status: "lagging", usdMicros: state.usdMicros });
    }
  }

  /**
   * Reads the given threads, every thread not yet settled, and with `all`, every known thread; then
   * retries the ones whose accounting has not caught up. Calls coalesce into one read loop.
   */
  refresh(threadIds: readonly string[] | "all"): void {
    if (!this.rootThreadId) return;
    for (const [threadId, state] of this.threads) {
      const unsettled = state.status === "unknown" || state.status === "lagging";
      if (threadIds === "all" || threadIds.includes(threadId) || unsettled) {
        this.dirty.add(threadId);
      }
    }
    this.attempt = 0;
    if (this.running) {
      this.rerun = true;
      this.wake?.();
      return;
    }
    void this.run(this.generation);
  }

  private cancel(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
    this.wake = null;
    this.running = false;
    this.rerun = false;
    this.attempt = 0;
  }

  private async run(generation: number): Promise<void> {
    this.running = true;
    try {
      while (generation === this.generation && this.dirty.size > 0) {
        this.rerun = false;
        const threadIds = [...this.dirty];
        await this.readAll(threadIds, generation);
        if (generation !== this.generation) return;
        this.publish();
        if (this.dirty.size === 0) return;
        if (!this.rerun) {
          const delay = RETRY_DELAYS_MS[this.attempt];
          if (delay === undefined) {
            this.giveUp();
            return;
          }
          this.attempt += 1;
          await this.sleep(delay);
        }
      }
    } finally {
      if (generation === this.generation) this.running = false;
    }
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
    });
  }

  private async readAll(threadIds: readonly string[], generation: number): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < threadIds.length && generation === this.generation) {
        const threadId = threadIds[next++]!;
        await this.readOne(threadId, generation);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_READS, threadIds.length) }, worker),
    );
  }

  private async readOne(threadId: string, generation: number): Promise<void> {
    let usage: z.infer<typeof CodexThreadUsageResponseSchema>["threadUsage"];
    try {
      usage = CodexThreadUsageResponseSchema.parse(
        await this.options.readUsage(threadId),
      ).threadUsage;
    } catch (error) {
      // Keep the last reading; the thread stays dirty and is read again.
      this.options.logger.debug({ err: error, threadId }, "Failed to read Codex thread cost");
      return;
    }
    const state = this.threads.get(threadId);
    if (generation !== this.generation || !state) return;
    const usdMicros = usage?.estimatedUsageUsdMicros;
    if (usdMicros == null) {
      if (!("usdMicros" in state)) this.threads.set(threadId, { status: "unpriced" });
      this.dirty.delete(threadId);
      return;
    }
    const groups = usage?.groups ?? [];
    const accountedTokens = groups.reduce((sum, group) => sum + (group.totalTokens ?? 0), 0);
    const best = Math.max("usdMicros" in state ? state.usdMicros : 0, usdMicros);
    if (groups.length === 0 && best === 0) {
      // Accounting has not started for this thread; leave it unknown rather than zero.
      return;
    }
    if (accountedTokens < (this.reportedTokens.get(threadId) ?? 0)) {
      this.threads.set(threadId, { status: "lagging", usdMicros: best });
      return;
    }
    this.threads.set(threadId, { status: "settled", usdMicros: best });
    this.dirty.delete(threadId);
  }

  /** Retries ran out: a thread that never showed any accounting has spent nothing. */
  private giveUp(): void {
    for (const threadId of this.dirty) {
      const state = this.threads.get(threadId);
      if (state?.status === "unknown" && !this.reportedTokens.has(threadId)) {
        this.threads.set(threadId, { status: "settled", usdMicros: 0 });
      } else if (!this.warnedThreadIds.has(threadId)) {
        this.warnedThreadIds.add(threadId);
        this.options.logger.warn(
          { threadId, rootThreadId: this.rootThreadId, state },
          "Codex thread cost accounting did not catch up; the chat total may be low",
        );
      }
    }
    this.dirty.clear();
    this.publish();
    if (this.resumed && this.publishedUsdMicros === null) {
      this.options.logger.warn(
        { rootThreadId: this.rootThreadId, discoveryComplete: this.discoveryComplete },
        "Codex chat cost is incomplete after resume; keeping the stored total",
      );
    }
  }

  private publish(): void {
    const root = this.rootThreadId ? this.threads.get(this.rootThreadId) : undefined;
    if (!root || !("usdMicros" in root)) return;
    let totalUsdMicros = 0;
    let complete = this.discoveryComplete;
    for (const [threadId, state] of this.threads) {
      if ("usdMicros" in state) {
        totalUsdMicros += state.usdMicros;
      } else {
        complete = false;
        if (state.status === "unpriced" && !this.warnedThreadIds.has(threadId)) {
          this.warnedThreadIds.add(threadId);
          this.options.logger.warn(
            { threadId, rootThreadId: this.rootThreadId },
            "Codex has no USD price for a subagent thread; the chat total leaves it out",
          );
        }
      }
    }
    if (this.resumed && this.publishedUsdMicros === null && !complete) return;
    if (totalUsdMicros <= (this.publishedUsdMicros ?? -1)) return;
    this.publishedUsdMicros = totalUsdMicros;
    this.options.publish(totalUsdMicros / 1_000_000);
  }
}
