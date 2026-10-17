import type { EditorView } from "@codemirror/view";
import { afterEach, expect, test } from "vitest";
import { fileEditorWebViewHtml } from "./file-editor-webview-html";
import {
  FILE_EDITOR_WEBVIEW_PROTOCOL,
  FILE_EDITOR_WEBVIEW_RECEIVE,
  type FileEditorHostMessage,
  type FileEditorWebViewMessage,
} from "./protocol";

interface EditorFrameWindow extends Window {
  [FILE_EDITOR_WEBVIEW_RECEIVE](message: FileEditorHostMessage): void;
  __paseoFileEditor?: EditorView;
}
const theme = {
  colorScheme: "dark",
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  foregroundMuted: "#888888",
  border: "#333333",
  selection: "#444444",
  monoFont: "Menlo",
  codeFontSize: 12,
  syntax: {},
} as never;
let frame: HTMLIFrameElement;

// The page bundles its own CodeMirror, so undo goes through its keymap, not this module's.
function pressUndo(view: EditorView) {
  const mac = /Mac/.test(navigator.platform);
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "z", metaKey: mac, ctrlKey: !mac, bubbles: true }),
  );
}
afterEach(() => frame?.remove());

test("the generated WebView mounts, reports edits as ChangeSets and takes remote documents outside undo", async () => {
  const messages: FileEditorWebViewMessage[] = [];
  frame = document.createElement("iframe");
  frame.style.width = "500px";
  frame.style.height = "300px";
  document.body.append(frame);
  const win = frame.contentWindow as EditorFrameWindow;
  Object.assign(win, {
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
  });
  win.document.open();
  win.document.write(fileEditorWebViewHtml);
  win.document.close();
  await expect
    .poll(() => messages[0])
    .toEqual({
      type: "bridgeReady",
      protocol: FILE_EDITOR_WEBVIEW_PROTOCOL,
    });
  const send = (message: FileEditorHostMessage) => win[FILE_EDITOR_WEBVIEW_RECEIVE](message);
  send({
    type: "mount",
    content: "one\ntwo\nthree",
    remoteRev: 1,
    filename: "a.ts",
    theme,
    vim: false,
  });
  expect(messages.at(-1)).toEqual({ type: "editorReady" });
  const view = win.__paseoFileEditor!;

  view.dispatch({ changes: { from: 3, insert: "!" }, userEvent: "input.type" });
  expect(messages.findLast((m) => m.type === "edit")).toEqual({
    type: "edit",
    changes: [3, [0, "!"], 10],
    baseRemoteRev: 1,
    length: 14,
  });

  send({ type: "setDocument", content: "theirs", remoteRev: 2 });
  expect(view.state.doc.toString()).toBe("theirs");
  pressUndo(view);
  // Undo reverts the user's own edit history, never the remote replacement.
  expect(view.state.doc.toString()).toBe("theirs");

  send({ type: "setDocument", content: "a\nb\nc\nd", remoteRev: 3 });
  send({ type: "reveal", lineStart: 2, lineEnd: 3 });
  const { from, to } = view.state.selection.main;
  expect(view.state.sliceDoc(from, to)).toBe("b\nc");

  view.dispatch({ changes: { from: 0, insert: ">" }, userEvent: "input.type" });
  expect(messages.findLast((m) => m.type === "edit")).toMatchObject({ baseRemoteRev: 3 });
  send({ type: "requestSync" });
  expect(messages.at(-1)).toEqual({ type: "sync", content: ">a\nb\nc\nd", baseRemoteRev: 3 });
});

test("find in the page counts, steps, replaces and keeps the match above the host's bar", async () => {
  const messages: FileEditorWebViewMessage[] = [];
  frame = document.createElement("iframe");
  frame.style.width = "500px";
  frame.style.height = "300px";
  document.body.append(frame);
  const win = frame.contentWindow as EditorFrameWindow;
  Object.assign(win, {
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
  });
  win.document.open();
  win.document.write(fileEditorWebViewHtml);
  win.document.close();
  await expect.poll(() => messages.length).toBeGreaterThan(0);
  const send = (message: FileEditorHostMessage) => win[FILE_EDITOR_WEBVIEW_RECEIVE](message);
  const lines = Array.from({ length: 200 }, (_, i) => (i === 120 ? "needle here" : `line ${i}`));
  lines[3] = "a Needle";
  send({
    type: "mount",
    content: lines.join("\n"),
    remoteRev: 1,
    filename: "a.txt",
    theme,
    vim: false,
  });
  const view = win.__paseoFileEditor!;
  const findState = () =>
    (
      messages.findLast((m) => m.type === "findState") as
        | Extract<FileEditorWebViewMessage, { type: "findState" }>
        | undefined
    )?.state;

  send({ type: "findWidgetSize", height: 100 });
  send({ type: "find", op: "open" });
  expect(findState()).toMatchObject({ open: true, readOnly: false });
  send({ type: "findQuery", query: "needle" });
  await expect.poll(() => findState()).toMatchObject({ query: "needle", total: 2, current: 1 });
  send({ type: "find", op: "next" });
  await expect.poll(() => findState()).toMatchObject({ current: 2 });
  await expect
    .poll(() => {
      const coords = view.coordsAtPos(view.state.selection.main.to);
      const editor = view.scrollDOM.getBoundingClientRect();
      return coords ? editor.bottom - coords.bottom : -1;
    })
    .toBeGreaterThanOrEqual(100);

  send({ type: "findReplacement", replacement: "pin" });
  send({ type: "find", op: "replaceAll" });
  expect(view.state.doc.toString()).not.toMatch(/needle/i);
  expect(messages.findLast((m) => m.type === "edit")).toBeTruthy();
  pressUndo(view);
  expect(view.state.doc.line(4).text).toBe("a Needle");
  expect(view.state.doc.line(121).text).toBe("needle here");

  send({ type: "find", op: "close" });
  expect(findState()).toMatchObject({ open: false });
});
