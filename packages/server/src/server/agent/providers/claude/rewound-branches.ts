/**
 * Claude Code rewinds a session in place by appending a `last-prompt` marker with `rewound: true`
 * and `leafUuid` set to the last message it kept. The rows it cut stay in the transcript, and the
 * next message branches off `leafUuid`. Claude's own resume follows the chain from the newest leaf,
 * so it never sees them; a reader that walks the file line by line must drop them itself.
 *
 * A rewind cuts every row written before its marker that descends from its leaf, along with
 * metadata pointing at a cut message (file-history snapshots). Rows written after the marker are
 * the new branch. Walking back from the newest leaf instead would also drop the results of
 * parallel tool calls, which hang off sibling tool_use rows rather than the main chain.
 *
 * Claude writes the marker lazily, so a reader that just rewound passes `pendingRewind` with the
 * leaf from the control response; `leafUuid: null` cuts the whole conversation. Applying a rewind
 * whose marker has since landed on disk cuts nothing more.
 */
export function dropRewoundBranches(
  content: string,
  options: { pendingRewind?: { leafUuid: string | null } } = {},
): string {
  const pending = options.pendingRewind;
  if (!pending && !content.includes('"rewound"')) return content;

  const lines = content.split(/\r?\n/);
  const index = new RewindBranchIndex();
  for (const line of lines) index.add(parseEntry(line));
  if (pending) index.cut(pending.leafUuid);
  return index.hasDrops ? lines.filter((_, row) => index.keeps(row)).join("\n") : content;
}

/** Tracks only transcript relationships; message bodies stay in the indexed file. */
export class RewindBranchIndex {
  private readonly entries: { uuid?: string; messageId?: string }[] = [];
  private readonly dropped = new Set<number>();
  private readonly droppedUuids = new Set<string>();
  private readonly childrenByParent = new Map<string, number[]>();

  add(entry: Record<string, unknown> | null): void {
    const row = this.entries.length;
    const uuid = typeof entry?.uuid === "string" ? entry.uuid : undefined;
    const messageId = typeof entry?.messageId === "string" ? entry.messageId : undefined;
    this.entries.push({ uuid, messageId });
    if (entry?.type === "last-prompt" && entry.rewound === true) {
      this.cut(typeof entry.leafUuid === "string" ? entry.leafUuid : null);
      return;
    }
    if (!uuid) return;
    const parent = typeof entry?.parentUuid === "string" ? entry.parentUuid : ROOT;
    const siblings = this.childrenByParent.get(parent) ?? [];
    siblings.push(row);
    this.childrenByParent.set(parent, siblings);
  }

  cut(leafUuid: string | null): void {
    const pending = [leafUuid ?? ROOT];
    while (pending.length) {
      const parent = pending.pop()!;
      const children = this.childrenByParent.get(parent) ?? [];
      this.childrenByParent.delete(parent);
      for (const row of children) {
        this.dropped.add(row);
        const uuid = this.entries[row]?.uuid;
        if (uuid) {
          this.droppedUuids.add(uuid);
          pending.push(uuid);
        }
      }
    }
  }

  get hasDrops(): boolean {
    return this.dropped.size > 0;
  }

  keeps(row: number): boolean {
    const messageId = this.entries[row]?.messageId;
    return !this.dropped.has(row) && !(messageId && this.droppedUuids.has(messageId));
  }
}

/** Parent key for rows that start the conversation. */
const ROOT = "";

function parseEntry(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
