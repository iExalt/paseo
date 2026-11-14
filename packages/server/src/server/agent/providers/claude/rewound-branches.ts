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
