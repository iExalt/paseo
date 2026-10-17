import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import { usePaneFindRequest } from "@/pane-find/open-requests";
import { useBackClosesFind } from "@/pane-find/use-back-closes-find";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { MatchPart } from "@/find-highlight/split";
import { findLineMatches, type LineMatch } from "./line-matches";

// Plain files reach 10 MB on native, so a scan waits for typing to pause.
const QUERY_DEBOUNCE_MS = 150;

export interface FileFind {
  open: boolean;
  query: string;
  status: string;
  canNavigate: boolean;
  /** Each matched line split at its matches, numbered across the file. */
  partsByLine: ReadonlyMap<number, MatchPart[]>;
  current: { line: number; index: number } | null;
  widget: React.RefObject<PaneFindHandle | null>;
  setQuery(query: string): void;
  next(): void;
  previous(): void;
  close(): void;
}

function partsByLine(texts: readonly string[], matches: readonly LineMatch[]) {
  const byLine = new Map<number, MatchPart[]>();
  let index = 0;
  while (index < matches.length) {
    const line = matches[index]!.line;
    const text = texts[line]!;
    const parts: MatchPart[] = [];
    let cursor = 0;
    for (; index < matches.length && matches[index]!.line === line; index += 1) {
      const match = matches[index]!;
      if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), match: null });
      parts.push({ text: text.slice(match.start, match.end), match: index });
      cursor = match.end;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor), match: null });
    byLine.set(line, parts);
  }
  return byLine;
}

/** Find in the read-only file view, with the semantics of web file find. */
export function useFileFind({
  texts,
  path,
  onReveal,
}: {
  texts: readonly string[];
  path: string;
  onReveal(line: number): void;
}): FileFind {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const active = useRetainedPanelActive();
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [searched, setSearched] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearched(query), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const result = useMemo(
    () => (open ? findLineMatches(texts, searched) : { matches: [], limited: false }),
    [open, searched, texts],
  );
  const byLine = useMemo(() => partsByLine(texts, result.matches), [result.matches, texts]);
  // A new search starts at its first match, as on web.
  useEffect(() => setCurrentIndex(0), [result]);

  const match = result.matches[currentIndex] ?? null;
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  useEffect(() => {
    if (match) reveal.current(match.line);
  }, [match]);

  const close = useCallback(() => {
    setOpen(false);
    setQueryState("");
    setSearched("");
  }, []);
  const openFind = useCallback(() => {
    setOpen(true);
    widget.current?.focus();
  }, []);
  usePaneFindRequest(active ? `file:${path}` : null, openFind);
  useEffect(() => {
    if (!active) close();
  }, [active, close]);
  useBackClosesFind(open, close);

  const count = result.matches.length;
  const step = useCallback(
    (direction: 1 | -1) => {
      if (count > 0) setCurrentIndex((index) => (index + direction + count) % count);
    },
    [count],
  );
  const next = useCallback(() => step(1), [step]);
  const previous = useCallback(() => step(-1), [step]);

  const total = `${count}${result.limited ? "+" : ""}`;
  let status = "";
  if (searched) {
    status =
      count === 0
        ? t("paneFind.noMatches")
        : t("paneFind.position", { current: currentIndex + 1, total });
  }
  const current = useMemo(
    () => (match ? { line: match.line, index: currentIndex } : null),
    [currentIndex, match],
  );
  return {
    open,
    query,
    status,
    canNavigate: count > 0,
    partsByLine: byLine,
    current,
    widget,
    setQuery: setQueryState,
    next,
    previous,
    close,
  };
}

/** The bottom find bar, as native chat find draws it. */
export function FileFindBar({ find }: { find: FileFind }) {
  if (!find.open) return null;
  return (
    <View style={styles.overlay}>
      <PaneFind
        ref={find.widget}
        fill
        query={find.query}
        status={find.status}
        canNavigate={find.canNavigate}
        onQueryChange={find.setQuery}
        onNext={find.next}
        onPrevious={find.previous}
        onClose={find.close}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Bottom, not top: the keyboard shift translates the pane up while the field has focus.
  overlay: {
    position: "absolute",
    bottom: theme.spacing[2],
    left: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 10,
  },
}));
