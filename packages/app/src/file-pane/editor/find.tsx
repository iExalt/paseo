import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, type PaneFindHandle, type PaneFindProps } from "@/pane-find";
import { usePaneFindRequest } from "@/pane-find/open-requests";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { FileEditorBridge } from "./webview/host-bridge";
import type { FileEditorFindOp, FileEditorFindState } from "./webview/protocol";

// Typing pauses before a search runs over a document of up to 1 MB.
const QUERY_DEBOUNCE_MS = 150;
const CLOSED: FileEditorFindState = {
  open: false,
  query: "",
  replacement: "",
  current: 0,
  total: 0,
  limited: false,
  readOnly: true,
};

export interface EditorFind {
  state: FileEditorFindState;
  query: string;
  replacement: string;
  next(): void;
  previous(): void;
  close(): void;
  /** The replace row's props, or undefined for a read-only document. */
  replace: PaneFindProps["replace"];
  widget: React.RefObject<PaneFindHandle | null>;
  /** Route the page's find messages here. */
  receiveState(state: FileEditorFindState): void;
  open(): void;
  setQuery(query: string): void;
  setReplacement(replacement: string): void;
  run(op: FileEditorFindOp): void;
}

/**
 * Find in the native editor: the page's FileFindModel matches and replaces, as on web;
 * the host draws the bar. It takes Find requests only while the editor is ready, so the
 * read-only view's own find owns them until then.
 */
export function useEditorFind({
  bridge,
  path,
  ready,
}: {
  bridge: FileEditorBridge;
  path: string;
  ready: boolean;
}): EditorFind {
  const widget = useRef<PaneFindHandle>(null);
  const active = useRetainedPanelActive();
  const [state, setState] = useState(CLOSED);
  // Fields keep their own text, so a late echo from the page never moves the caret.
  const [query, setQueryState] = useState("");
  const [replacement, setReplacementState] = useState("");

  const wasOpen = useRef(false);
  const receiveState = useCallback((next: FileEditorFindState) => {
    // Opening seeds the query from the selection, as on web.
    if (next.open && !wasOpen.current) {
      setQueryState(next.query);
      setReplacementState(next.replacement);
    }
    wasOpen.current = next.open;
    setState(next);
  }, []);
  const run = useCallback((op: FileEditorFindOp) => bridge.update({ type: "find", op }), [bridge]);
  const open = useCallback(() => run("open"), [run]);
  const setReplacement = useCallback(
    (value: string) => {
      setReplacementState(value);
      bridge.update({ type: "findReplacement", replacement: value });
    },
    [bridge],
  );

  useEffect(() => {
    if (!state.open || query === state.query) return undefined;
    const timer = setTimeout(() => bridge.update({ type: "findQuery", query }), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [bridge, query, state.open, state.query]);

  useEffect(() => {
    if (state.open) widget.current?.focus();
  }, [state.open]);
  usePaneFindRequest(active && ready ? `file:${path}` : null, open);
  useEffect(() => {
    if (!active && state.open) run("close");
  }, [active, run, state.open]);
  useEffect(() => {
    if (!state.open) return undefined;
    // Android back closes the find bar before it leaves the file.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      run("close");
      return true;
    });
    return () => subscription.remove();
  }, [run, state.open]);

  const next = useCallback(() => run("next"), [run]);
  const previous = useCallback(() => run("previous"), [run]);
  const close = useCallback(() => run("close"), [run]);
  const replace = useMemo(
    () =>
      state.readOnly
        ? undefined
        : {
            value: replacement,
            onChange: setReplacement,
            onReplace: () => run("replace"),
            onReplaceAll: () => run("replaceAll"),
          },
    [replacement, run, setReplacement, state.readOnly],
  );

  return {
    state,
    query,
    replacement,
    next,
    previous,
    close,
    replace,
    widget,
    receiveState,
    open,
    setQuery: setQueryState,
    setReplacement,
    run,
  };
}

/** The bottom find bar over the editor; its height keeps revealed matches clear of it. */
export function EditorFindBar({ find, bridge }: { find: EditorFind; bridge: FileEditorBridge }) {
  const { t } = useTranslation();
  const { state } = find;
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      // The bar's height plus the inset below it.
      const { height } = event.nativeEvent.layout;
      bridge.update({ type: "findWidgetSize", height: Math.ceil(height + BAR_INSET) });
    },
    [bridge],
  );
  if (!state.open) return null;
  const total = `${state.total}${state.limited ? "+" : ""}`;
  let status = "";
  if (state.query) {
    if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current) status = t("paneFind.position", { current: state.current, total });
    else status = t("paneFind.total", { total });
  }
  return (
    <View style={styles.overlay} onLayout={measure}>
      <PaneFind
        ref={find.widget}
        fill
        query={find.query}
        status={status}
        canNavigate={state.total > 0}
        onQueryChange={find.setQuery}
        onNext={find.next}
        onPrevious={find.previous}
        onClose={find.close}
        replace={find.replace}
      />
    </View>
  );
}

const BAR_INSET = 8;

const styles = StyleSheet.create((theme) => ({
  // Bottom, as the read-only view's bar: the keyboard shift moves the pane up with it.
  overlay: {
    position: "absolute",
    bottom: BAR_INSET,
    left: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 10,
  },
}));
