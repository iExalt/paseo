import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { FileSourceView } from "../source/view";
import type { FileEditorViewProps } from "./view-contract";
import { FileEditorBridge } from "./webview/host-bridge";
import { fileEditorWebViewHtml } from "./webview/file-editor-webview-html";
import {
  FILE_EDITOR_WEBVIEW_RECEIVE,
  parseWebViewMessage,
  serializeHostMessage,
  type FileEditorHostMessage,
} from "./webview/protocol";

const SOURCE = { html: fileEditorWebViewHtml };
const ORIGIN_WHITELIST = ["*"];
// A renderer that dies or never starts this many times leaves the file read-only.
const MAX_RESETS = 3;
const READY_TIMEOUT_MS = 10_000;

/**
 * CodeMirror in a WebView, as on web. The read-only source view shows the file until the
 * editor is ready, and stays when the editor cannot run.
 */
export function FileEditorView({
  ref,
  model,
  filename,
  location,
  navigationRevision,
  vimEnabled,
  theme,
  onCursorChange,
  onVimModeChange,
}: FileEditorViewProps) {
  const { t } = useTranslation();
  const webViewRef = useRef<WebView>(null);
  const [epoch, setEpoch] = useState(0);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const resets = useRef(0);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const view = useRef({ filename, theme, vim: vimEnabled });
  view.current = { filename, theme, vim: vimEnabled };
  const callbacks = useRef({ onCursorChange, onVimModeChange });
  callbacks.current = { onCursorChange, onVimModeChange };

  const [bridge] = useState(
    () =>
      new FileEditorBridge({
        model,
        send: (message: FileEditorHostMessage) =>
          webViewRef.current?.injectJavaScript(
            `window.${FILE_EDITOR_WEBVIEW_RECEIVE}?.(${serializeHostMessage(message)});true;`,
          ),
        events: {
          onProtocolMismatch: () => setUnavailable(true),
          onEditorReady: () => setReady(true),
          onCursorChange: (position) => callbacks.current.onCursorChange(position),
          onVimModeChange: (mode) => callbacks.current.onVimModeChange(mode),
        },
      }),
  );
  useEffect(() => () => bridge.dispose(), [bridge]);
  useImperativeHandle(ref, () => ({ flush: () => bridge.flush() }), [bridge]);

  const resetWebView = useCallback(() => {
    bridge.reset();
    setReady(false);
    resets.current += 1;
    if (resets.current >= MAX_RESETS) setUnavailable(true);
    else setEpoch((value) => value + 1);
  }, [bridge]);

  useEffect(() => {
    if (ready || unavailable) return undefined;
    const timer = setTimeout(resetWebView, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [epoch, ready, resetWebView, unavailable]);

  useEffect(() => bridge.update({ type: "setFilename", filename }), [bridge, filename]);
  useEffect(() => bridge.update({ type: "setTheme", theme }), [bridge, theme]);
  useEffect(() => bridge.update({ type: "setVim", enabled: vimEnabled }), [bridge, vimEnabled]);
  useEffect(() => {
    if (!ready || !location.lineStart) return;
    bridge.update({ type: "reveal", lineStart: location.lineStart, lineEnd: location.lineEnd });
  }, [bridge, location.lineEnd, location.lineStart, navigationRevision, ready]);

  // Backgrounding may stop the renderer: bring its edits over and save them.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      void bridge.flush().then(() => model.save());
    });
    return () => subscription.remove();
  }, [bridge, model]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseWebViewMessage(event.nativeEvent.data);
      if (message) bridge.receive(message, view.current);
    },
    [bridge],
  );
  const handleProcessGone = useCallback(() => resetWebView(), [resetWebView]);

  const readOnly = (
    <FileSourceView
      content={snapshot.content}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      size={snapshot.content.length}
      theme={theme}
      tooLargeMessage={t("panels.file.tooLargeToDisplay")}
    />
  );
  if (unavailable) return <View style={styles.root}>{readOnly}</View>;
  return (
    <View style={styles.root}>
      {ready ? null : readOnly}
      {/* Transparent and untouchable over the read-only view until the editor is ready. */}
      <View style={ready ? styles.fill : styles.loading} pointerEvents={ready ? "auto" : "none"}>
        <WebView
          key={epoch}
          ref={webViewRef}
          source={SOURCE}
          style={[styles.fill, { backgroundColor: theme.background }]}
          containerStyle={styles.fill}
          originWhitelist={ORIGIN_WHITELIST}
          bounces={false}
          overScrollMode="never"
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          allowsLinkPreview={false}
          setSupportMultipleWindows={false}
          setBuiltInZoomControls={false}
          setDisplayZoomControls={false}
          textZoom={100}
          onMessage={handleMessage}
          onContentProcessDidTerminate={handleProcessGone}
          onRenderProcessGone={handleProcessGone}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  fill: { flex: 1 },
  loading: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, opacity: 0 },
});
