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
  const entries = lines.map(parseEntry);
  const dropped = new Set<number>();
  const droppedUuids = new Set<string>();
  const childrenByParent = new Map<string, number[]>();

  const cut = (leafUuid: string | null): void => {
    const leaf = leafUuid ?? ROOT;
    for (const index of descendantsOf(leaf)) {
      dropped.add(index);
      const uuid = entries[index]?.uuid;
      if (typeof uuid === "string") droppedUuids.add(uuid);
    }
    // Forget what was cut, so rows after this marker branch off the leaf alone, while a later
    // rewind further back still cuts the rows this one kept.
    childrenByParent.delete(leaf);
    for (const uuid of droppedUuids) childrenByParent.delete(uuid);
  };

  entries.forEach((entry, index) => {
    if (!entry) return;
    if (entry.type === "last-prompt" && entry.rewound === true) {
      cut(typeof entry.leafUuid === "string" ? entry.leafUuid : null);
      return;
    }
    if (typeof entry.uuid !== "string") return;
    const parent = typeof entry.parentUuid === "string" ? entry.parentUuid : ROOT;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(index);
    childrenByParent.set(parent, siblings);
  });
  if (pending) cut(pending.leafUuid);
  if (dropped.size === 0) return content;

  return lines
    .filter((_, index) => {
      if (dropped.has(index)) return false;
      const messageId = entries[index]?.messageId;
      return !(typeof messageId === "string" && droppedUuids.has(messageId));
    })
    .join("\n");

  function* descendantsOf(uuid: string): Generator<number> {
    for (const child of childrenByParent.get(uuid) ?? []) {
      yield child;
      const childUuid = entries[child]?.uuid;
      if (typeof childUuid === "string") yield* descendantsOf(childUuid);
    }
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
