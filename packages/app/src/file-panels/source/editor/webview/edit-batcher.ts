import type { ChangeSet } from "@codemirror/state";

/** Below this document length every edit is sent at once, so closing a tab loses nothing. */
const IMMEDIATE_LENGTH = 100_000;
/** Above it, edits are composed for this long; each send copies a ChangeSet, not the file. */
const BATCH_MS = 100;

export interface EditBatcherClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

/** Composes the WebView's edits into one ChangeSet per send. */
export class EditBatcher {
  private pending: ChangeSet | null = null;
  private length = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (changes: ChangeSet, length: number) => void,
    private readonly clock: EditBatcherClock = globalThis,
  ) {}

  add(changes: ChangeSet, length: number): void {
    this.pending = this.pending ? this.pending.compose(changes) : changes;
    this.length = length;
    if (length < IMMEDIATE_LENGTH) {
      this.flush();
      return;
    }
    this.timer ??= this.clock.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, BATCH_MS);
  }

  flush(): void {
    this.cancelTimer();
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.send(pending, this.length);
  }

  /** Drop what is pending: the document it applies to was replaced. */
  reset(): void {
    this.cancelTimer();
    this.pending = null;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
