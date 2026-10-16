import type { ChangeSet } from "@codemirror/state";
import type { EditorVisualTheme } from "../visual-theme";

/**
 * The one message contract between the native editor host and the CodeMirror WebView.
 * Bump it when a message changes shape; the host falls back to the read-only view when
 * the bundled WebView reports another version.
 */
export const FILE_EDITOR_WEBVIEW_PROTOCOL = 2;

/** `ChangeSet.toJSON()`: what one edit did to the WebView's document. */
export type FileEditorChangesJSON = ReturnType<ChangeSet["toJSON"]>;

/**
 * Host to WebView. Documents travel with the host's `remoteRev`, the count of changes
 * that did not come from the WebView, so edits made against an older document can be
 * recognised and dropped.
 */
export type FileEditorHostMessage =
  | {
      type: "mount";
      content: string;
      remoteRev: number;
      filename: string;
      theme: EditorVisualTheme;
      vim: boolean;
    }
  | { type: "setDocument"; content: string; remoteRev: number }
  | { type: "setFilename"; filename: string }
  | { type: "setTheme"; theme: EditorVisualTheme }
  | { type: "setVim"; enabled: boolean }
  | { type: "reveal"; lineStart: number; lineEnd?: number }
  | { type: "focus" }
  | { type: "blur" }
  /** Send any edit still waiting in the WebView, then answer `flushed`. */
  | { type: "flush"; requestId: number }
  /** The host's copy drifted: send the whole document. */
  | { type: "requestSync" }
  | { type: "find"; op: FileEditorFindOp }
  | { type: "findQuery"; query: string }
  | { type: "findReplacement"; replacement: string }
  /** Height the host's find bar covers at the bottom, so matches are revealed above it. */
  | { type: "findWidgetSize"; height: number };

export type FileEditorFindOp = "open" | "close" | "next" | "previous" | "replace" | "replaceAll";

/** Find as the page's FileFindModel sees it. */
export interface FileEditorFindState {
  open: boolean;
  query: string;
  replacement: string;
  current: number;
  total: number;
  limited: boolean;
  readOnly: boolean;
}

/** WebView to host. Documents and checksums are of the WebView's `\n`-joined text. */
export type FileEditorWebViewMessage =
  | { type: "bridgeReady"; protocol: number }
  | { type: "editorReady" }
  | {
      type: "edit";
      changes: FileEditorChangesJSON;
      baseRemoteRev: number;
      /** Document length after the change, so the host notices drift at once. */
      length: number;
    }
  | { type: "sync"; content: string; baseRemoteRev: number }
  | { type: "flushed"; requestId: number; checksum: string }
  | { type: "save"; checksum: string }
  | { type: "cursor"; line: number; column: number }
  | { type: "vimMode"; mode: string | null }
  | { type: "findState"; state: FileEditorFindState }
  /** Mod-f from a hardware keyboard inside the page. */
  | { type: "findRequest" };

export const FILE_EDITOR_WEBVIEW_RECEIVE = "__PASEO_FILE_EDITOR_WEBVIEW_RECEIVE__";

/**
 * Length and 32-bit FNV-1a of the text. Cheap enough to run over a 1 MB document on
 * save, and enough to catch a host copy that drifted from the WebView's.
 */
export function documentChecksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * A host message as a JavaScript expression for `injectJavaScript`. File content can hold
 * `</script` and the U+2028/U+2029 separators, which older engines reject in source.
 */
export function serializeHostMessage(message: FileEditorHostMessage): string {
  return JSON.stringify(message)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const WEBVIEW_MESSAGE_TYPES = new Set<string>([
  "bridgeReady",
  "editorReady",
  "edit",
  "sync",
  "flushed",
  "save",
  "cursor",
  "vimMode",
  "findState",
  "findRequest",
]);

/** The WebView's message, or null for anything else the page might post. */
export function parseWebViewMessage(raw: string): FileEditorWebViewMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !WEBVIEW_MESSAGE_TYPES.has(type)) return null;
  return value as FileEditorWebViewMessage;
}
