import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { channel } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";
import { CursorProcessLedger } from "./cursor-sdk-process-ledger.js";

const owningTurn = new AsyncLocalStorage<CursorToolProcesses>();
const untracked = new AsyncLocalStorage<true>();

/** Run Paseo's own probe shells without marking live turns as having unknown shells. */
export function withoutShellTracking<T>(start: () => T): T {
  return untracked.run(true, start);
}
const shellExecutables = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
]);
const posix = process.platform === "linux" || process.platform === "darwin";
// Node 24 (the Electron desktop runtime) and the project-selected Node 26 publish
// the spawn tracing channel. For other runtimes, require an actual attributable
// trace before trusting negative evidence.
export const knownSpawnTracing = posix && Number(process.versions.node.split(".")[0]) >= 24;

interface SpawnEvent {
  process?: ChildProcess;
  options?: { detached?: boolean; args?: string[]; file?: string };
}

// The pinned SDK starts shell commands with -c. Its idle login-shell
// prewarm also uses detached spawn, but has no command to stop.
function isToolShell(options: NonNullable<SpawnEvent["options"]>): boolean {
  return (
    options.detached === true &&
    Array.isArray(options.args) &&
    options.args.includes("-c") &&
    typeof options.file === "string" &&
    shellExecutables.has(basename(options.file))
  );
}

function observeSpawnStart(message: unknown): void {
  if (!posix || untracked.getStore()) return;
  const { process: child, options } = (message ?? {}) as SpawnEvent;
  if (!child || !options) return;
  const scope = owningTurn.getStore();
  if (!scope) {
    if (isToolShell(options)) CursorProcessLedger.recordUnattributed();
    return;
  }
  scope.observeTrace();
  if (!isToolShell(options)) return;
  // Record the shell before it exists, so a crash cannot hide it from recovery.
  const intent = scope.ledger?.intent();
  // Trace-end runs before Node assigns ChildProcess.pid. Register its
  // successful spawn event before Node starts the child instead.
  child.once("spawn", () => {
    if (child.pid === undefined || child.pid <= 1) return;
    scope.addGroup(child.pid);
    if (intent !== undefined) scope.ledger?.spawned(intent, child.pid);
  });
  child.once("error", () => {
    if (intent !== undefined && child.pid === undefined) scope.ledger?.failed(intent);
  });
}

channel("tracing:child_process.spawn:start").subscribe(observeSpawnStart);

function groupMayExist(pgid: number): boolean {
  try {
    // Signal zero is a liveness query. We never send a signal to a recorded ID.
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class CursorToolProcesses {
  private readonly groups = new Set<number>();

  /** Without a ledger, the turn keeps its process records in memory only. */
  constructor(readonly ledger?: CursorProcessLedger) {}

  /** The turn is joined or never reached the SDK; drop its process record. */
  close(): void {
    this.ledger?.close();
  }

  private readonly shellCalls = new Set<string>();
  private observedTrace = false;

  observeTrace(): void {
    this.observedTrace = true;
  }

  scope<T>(start: () => T): T {
    return owningTurn.run(this, start);
  }

  addGroup(pgid: number): void {
    this.groups.add(pgid);
  }

  observeShellCall(callId: string): void {
    this.shellCalls.add(callId);
  }

  get canConfirmShellOwnership(): boolean {
    return (knownSpawnTracing || this.observedTrace) && this.groups.size >= this.shellCalls.size;
  }

  async waitForKnownGroupsToExit(): Promise<void> {
    while ([...this.groups].some(groupMayExist)) {
      await delay(25, undefined, { ref: false });
    }
  }
}
