import { appendFileSync, rmSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * A crash-safe record of the shells one Cursor SDK turn started.
 *
 * Without an execution owner (macOS, or Linux without systemd), the SDK runs its
 * tool shells as children of the daemon worker. If the worker dies mid-turn,
 * the replacement daemon reads this ledger to decide whether every shell the
 * turn started has exited. Each record is one synchronous append, written
 * before the shell exists, so a crash can lose only a record whose shell never
 * started. Recovery treats any record it cannot read as a shell that may still
 * be running.
 */

const ownerSchema = z.object({
  host: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.number(),
  tracing: z.boolean(),
});
const entrySchema = z.union([
  z.object({ owner: ownerSchema }).strict(),
  z.object({ intent: z.number().int().positive() }).strict(),
  z.object({ intent: z.number().int().positive(), pgid: z.number().int().gt(1) }).strict(),
  z.object({ intent: z.number().int().positive(), failed: z.literal(true) }).strict(),
  z.object({ unattributed: z.literal(true) }).strict(),
]);
type LedgerEntry = z.infer<typeof entrySchema>;

const live = new Set<CursorProcessLedger>();

export class CursorProcessLedger {
  private intents = 0;
  private broken = false;

  constructor(
    private readonly path: string,
    private readonly tracing: boolean,
  ) {}

  /** Record the owning daemon. Call before the turn can start any shell. */
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const startedAt = Math.round(Date.now() - process.uptime() * 1000);
    const owner = { host: hostname(), pid: process.pid, startedAt, tracing: this.tracing };
    await appendFile(this.path, `${JSON.stringify({ owner })}\n`, { mode: 0o600 });
    live.add(this);
  }

  /**
   * Runs inside the spawn tracing callback, before the shell exists, so it must
   * be synchronous and must not throw. A record that cannot be written takes
   * the whole ledger with it: recovery treats a missing ledger as unknown shells.
   */
  private write(entry: LedgerEntry): void {
    if (this.broken) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    } catch {
      this.broken = true;
      live.delete(this);
      try {
        rmSync(this.path, { force: true });
      } catch {
        // The torn or partial ledger that remains still blocks recovery.
      }
    }
  }

  /** Record a shell about to start; returns its number for the later records. */
  intent(): number {
    this.intents += 1;
    this.write({ intent: this.intents });
    return this.intents;
  }

  spawned(intent: number, pgid: number): void {
    this.write({ intent, pgid });
  }

  failed(intent: number): void {
    this.write({ intent, failed: true });
  }

  /** The turn is joined or never reached the SDK: nothing is left to recover. */
  close(): void {
    live.delete(this);
    void rm(this.path, { force: true }).catch(() => undefined);
  }

  /**
   * A detached shell started outside any turn's scope could belong to any live
   * turn, so every live turn must treat it as its own unknown shell.
   */
  static recordUnattributed(): void {
    for (const ledger of live) ledger.write({ unattributed: true });
  }
}

export type ProcessLedgerVerdict = { released: true } | { released: false; reason: string };

export interface ProcessProbe {
  processExists(pid: number): boolean;
  groupExists(pgid: number): boolean;
}

function signalZero(target: number): boolean {
  try {
    // Signal zero is a liveness query. Recovery never signals a recorded ID.
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const systemProbe: ProcessProbe = {
  processExists: (pid) => signalZero(pid),
  groupExists: (pgid) => signalZero(-pgid),
};

/** Decide whether every shell a dead daemon's turn started has exited. */
export async function assessProcessLedger(
  path: string,
  probe: ProcessProbe = systemProbe,
): Promise<ProcessLedgerVerdict> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { released: false, reason: "has no record of its tool processes" };
    }
    throw error;
  }
  const entries: LedgerEntry[] = [];
  for (const line of data.split("\n").filter(Boolean)) {
    const parsed = entrySchema.safeParse(safeJson(line));
    // A torn append may be the record of a shell that did start.
    if (!parsed.success) return { released: false, reason: "has an unreadable process record" };
    entries.push(parsed.data);
  }
  const first = entries[0];
  if (!first || !("owner" in first)) {
    return { released: false, reason: "has no record of its owning daemon" };
  }
  const { owner } = first;
  if (!owner.tracing) {
    return { released: false, reason: "ran where Paseo could not observe its shells" };
  }
  // Process IDs from another host or PID namespace say nothing about this one.
  if (owner.host !== hostname()) {
    return { released: false, reason: `ran on another host (${owner.host})` };
  }
  if (owner.pid === process.pid) {
    return { released: false, reason: "belongs to this daemon" };
  }
  // A reused process ID after a reboot also blocks; a person can confirm that case.
  if (probe.processExists(owner.pid)) {
    return { released: false, reason: `may still be running in process ${owner.pid}` };
  }
  return assessShells(entries.slice(1), probe);
}

function assessShells(entries: LedgerEntry[], probe: ProcessProbe): ProcessLedgerVerdict {
  const pending = new Set<number>();
  const groups: number[] = [];
  for (const entry of entries) {
    if ("unattributed" in entry) {
      return { released: false, reason: "started a shell Paseo could not attribute" };
    }
    if ("owner" in entry) return { released: false, reason: "has two owner records" };
    if ("pgid" in entry) {
      pending.delete(entry.intent);
      groups.push(entry.pgid);
    } else if ("failed" in entry) {
      pending.delete(entry.intent);
    } else {
      pending.add(entry.intent);
    }
  }
  if (pending.size > 0) {
    return { released: false, reason: "started a shell whose process group was never recorded" };
  }
  const running = groups.find((pgid) => probe.groupExists(pgid));
  if (running !== undefined) {
    return { released: false, reason: `still has shell process group ${running}` };
  }
  return { released: true };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
