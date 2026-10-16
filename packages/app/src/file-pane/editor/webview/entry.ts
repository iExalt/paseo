import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import { editorBaseExtensions, editorTheme } from "../extensions.web";
import type { EditorVisualTheme } from "../visual-theme";
import { EditBatcher } from "./edit-batcher";
import {
  documentChecksum,
  FILE_EDITOR_WEBVIEW_PROTOCOL,
  FILE_EDITOR_WEBVIEW_RECEIVE,
  type FileEditorHostMessage,
  type FileEditorWebViewMessage,
} from "./protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage?: (data: string) => void };
    [FILE_EDITOR_WEBVIEW_RECEIVE]?: (message: FileEditorHostMessage) => void;
    __paseoFileEditor?: EditorView;
  }
}

function post(message: FileEditorWebViewMessage): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
}

const languageCompartment = new Compartment();
const wrappingCompartment = new Compartment();
const themeCompartment = new Compartment();
const vimCompartment = new Compartment();
const selectionCompartment = new Compartment();
const remoteUpdate = Annotation.define<boolean>();

// Touch keeps the OS selection and its handles. Vim draws its cursor and visual mode on
// CodeMirror's selection layer, so it keeps the drawn selection.
const touch = window.matchMedia("(pointer: coarse)").matches;

function wrappingForFile(filename: string) {
  return isRenderedMarkdownFile(filename) ? EditorView.lineWrapping : [];
}

function selectionFor(vimEnabled: boolean) {
  return vimEnabled || !touch ? drawSelection() : [];
}

// A custom font may exist only natively, so the page falls back to a system monospace.
function webTheme(theme: EditorVisualTheme) {
  return editorTheme({ ...theme, monoFont: `${theme.monoFont}, ui-monospace, monospace` });
}

class FileEditorPage {
  private view: EditorView | null = null;
  private remoteRev = 0;
  private stopVimModes: (() => void) | null = null;
  private readonly batcher = new EditBatcher((changes, length) =>
    post({ type: "edit", changes: changes.toJSON(), baseRemoteRev: this.remoteRev, length }),
  );

  receive = (message: FileEditorHostMessage): void => {
    if (message.type === "mount") {
      this.mount(message);
      return;
    }
    const view = this.view;
    if (!view) return;
    switch (message.type) {
      case "setDocument":
        this.batcher.reset();
        this.remoteRev = message.remoteRev;
        this.replaceDocument(view, message.content);
        return;
      case "setFilename":
        view.dispatch({
          effects: [
            languageCompartment.reconfigure(getLanguageForFile(message.filename)?.extension ?? []),
            wrappingCompartment.reconfigure(wrappingForFile(message.filename)),
          ],
        });
        return;
      case "setTheme":
        view.dispatch({ effects: themeCompartment.reconfigure(webTheme(message.theme)) });
        return;
      case "setVim":
        this.setVim(view, message.enabled);
        return;
      case "reveal":
        this.reveal(view, message.lineStart, message.lineEnd);
        return;
      case "focus":
        view.focus();
        return;
      case "blur":
        view.contentDOM.blur();
        return;
      case "flush":
        this.batcher.flush();
        post({
          type: "flushed",
          requestId: message.requestId,
          checksum: documentChecksum(view.state.doc.toString()),
        });
        return;
      case "requestSync":
        this.batcher.reset();
        post({ type: "sync", content: view.state.doc.toString(), baseRemoteRev: this.remoteRev });
        return;
    }
  };

  flush = (): void => this.batcher.flush();

  private mount(message: Extract<FileEditorHostMessage, { type: "mount" }>): void {
    this.view?.destroy();
    this.batcher.reset();
    this.remoteRev = message.remoteRev;
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: message.content,
        extensions: [
          vimCompartment.of(message.vim ? vim() : []),
          selectionCompartment.of(selectionFor(message.vim)),
          ...editorBaseExtensions(this.save, { drawSelection: false }),
          languageCompartment.of(getLanguageForFile(message.filename)?.extension ?? []),
          wrappingCompartment.of(wrappingForFile(message.filename)),
          themeCompartment.of(webTheme(message.theme)),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(remoteUpdate))
            ) {
              this.batcher.add(update.changes, update.state.doc.length);
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              post({ type: "cursor", line: line.number, column: head - line.from + 1 });
            }
          }),
        ],
      }),
    });
    this.view = view;
    window.__paseoFileEditor = view;
    if (message.vim) this.watchVimModes(view);
    post({ type: "cursor", line: 1, column: 1 });
    post({ type: "editorReady" });
  }

  private save = (): void => {
    const view = this.view;
    if (!view) return;
    this.batcher.flush();
    post({ type: "save", checksum: documentChecksum(view.state.doc.toString()) });
  };

  private replaceDocument(view: EditorView, content: string): void {
    const doc = view.state.toText(content);
    if (view.state.doc.eq(doc)) return;
    const head = Math.min(view.state.selection.main.head, doc.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      selection: { anchor: head },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }

  private reveal(view: EditorView, lineStart: number, lineEnd: number | undefined): void {
    const start = Math.min(lineStart, view.state.doc.lines);
    const end = Math.min(lineEnd ?? start, view.state.doc.lines);
    const from = view.state.doc.line(start).from;
    const to = view.state.doc.line(Math.max(start, end)).to;
    view.dispatch({
      selection: { anchor: from, head: end > start ? to : from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  private setVim(view: EditorView, enabled: boolean): void {
    view.dispatch({
      effects: [
        vimCompartment.reconfigure(enabled ? vim() : []),
        selectionCompartment.reconfigure(selectionFor(enabled)),
      ],
    });
    this.stopVimModes?.();
    this.stopVimModes = null;
    if (enabled) this.watchVimModes(view);
    else post({ type: "vimMode", mode: null });
  }

  private watchVimModes(view: EditorView): void {
    const cm = getCM(view);
    if (!cm) return;
    const handleModeChange = (event: { mode?: string }) =>
      post({ type: "vimMode", mode: (event.mode ?? "normal").toUpperCase() });
    cm.on("vim-mode-change", handleModeChange);
    this.stopVimModes = () => cm.off("vim-mode-change", handleModeChange);
    post({ type: "vimMode", mode: "NORMAL" });
  }

  /** The soft keyboard or a rotation resized the page: keep the cursor in sight. */
  keepCursorVisible = (): void => {
    const view = this.view;
    if (!view?.hasFocus) return;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
  };
}

const style = document.createElement("style");
style.textContent = `
html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }
body { display: flex; }
body > .cm-editor { flex: 1; min-width: 0; min-height: 0; }
`;
document.head.append(style);

const page = new FileEditorPage();
window.visualViewport?.addEventListener("resize", page.keepCursorVisible);
// The renderer can be stopped once hidden; send what waits while it still runs.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") page.flush();
});
window.addEventListener("pagehide", page.flush);
window[FILE_EDITOR_WEBVIEW_RECEIVE] = page.receive;
post({ type: "bridgeReady", protocol: FILE_EDITOR_WEBVIEW_PROTOCOL });
