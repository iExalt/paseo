import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { channel } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";

const owningTurn = new AsyncLocalStorage<CursorToolProcesses>();
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
// The project-selected Node 26 implements the spawn tracing contract. For other
// runtimes, require an actual attributable trace before trusting negative evidence.
const knownSpawnTracing = posix && Number(process.versions.node.split(".")[0]) === 26;

interface SpawnEvent {
  process?: ChildProcess;
  options?: { detached?: boolean; args?: string[]; file?: string };
}

function observeSpawnStart(message: unknown): void {
  const scope = owningTurn.getStore();
  if (!scope || !posix) return;
  const { process: child, options } = (message ?? {}) as SpawnEvent;
  if (!child || !options) return;
  scope.observeTrace();
  // The pinned SDK starts shell commands with -c. Its idle login-shell
  // prewarm also uses detached spawn, but has no command to stop.
  if (options.detached !== true || !Array.isArray(options.args) || !options.args.includes("-c")) {
    return;
  }
  if (typeof options.file !== "string" || !shellExecutables.has(basename(options.file))) return;
  // Trace-end runs before Node assigns ChildProcess.pid. Register its
  // successful spawn event before Node starts the child instead.
  child.once("spawn", () => {
    if (child.pid !== undefined && child.pid > 1) scope.addGroup(child.pid);
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
