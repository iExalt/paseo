import { describe, expect, test } from "vitest";
import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import { FileEditorModel, type FileEditorClock } from "../model";
import type { EditorVisualTheme } from "../visual-theme";
import { FileEditorBridge } from "./host-bridge";
import {
  documentChecksum,
  FILE_EDITOR_WEBVIEW_PROTOCOL,
  type FileEditorHostMessage,
  type FileEditorWebViewMessage,
} from "./protocol";

class TestClock implements FileEditorClock {
  callbacks = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.next++;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.callbacks.delete(handle as unknown as number);
  }
  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

const version: Extract<FileVersion, { status: "ready" }> = {
  status: "ready",
  cwd: "/workspace",
  path: "file.ts",
  size: 3,
  modifiedAt: "2026-07-18T00:00:00.000Z",
};
const view = { filename: "file.ts", theme: {} as EditorVisualTheme, vim: false };

function setup(content: string) {
  const writes: string[] = [];
  const clock = new TestClock();
  const model = new FileEditorModel({
    file: { content, hasBom: false, version },
    session: {
      async write(input): Promise<FileWriteResult> {
        writes.push(input.content);
        return { status: "written", modifiedAt: "2026-07-18T00:00:01.000Z", size: 1 };
      },
    },
    clock,
  });
  const sent: FileEditorHostMessage[] = [];
  const events = { mismatch: [] as number[], ready: 0 };
  const bridge = new FileEditorBridge({
    model,
    clock,
    send: (message) => sent.push(message),
    events: {
      onProtocolMismatch: (protocol) => events.mismatch.push(protocol),
      onEditorReady: () => (events.ready += 1),
      onCursorChange: () => {},
      onVimModeChange: () => {},
      onFindState: () => {},
      onFindRequest: () => {},
    },
  });
  const receive = (message: FileEditorWebViewMessage) => bridge.receive(message, view);
  // The WebView's own `\n` document, edited as CodeMirror would.
  let doc = content.replace(/\r\n?/g, "\n");
  const sendEdit = (spec: ChangeSpec, baseRemoteRev: number) => {
    const changes = ChangeSet.of(spec, doc.length);
    let next = "";
    let cursor = 0;
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      next += doc.slice(cursor, fromA) + inserted.toString();
      cursor = toA;
    });
    doc = next + doc.slice(cursor);
    receive({ type: "edit", changes: changes.toJSON(), baseRemoteRev, length: doc.length });
  };
  const lastRev = () =>
    sent.findLast((m) => m.type === "mount" || m.type === "setDocument") as
      | { remoteRev: number }
      | undefined;
  return {
    model,
    bridge,
    clock,
    sent,
    events,
    writes,
    receive,
    sendEdit,
    doc: () => doc,
    setDoc: (next: string) => (doc = next),
    rev: () => lastRev()!.remoteRev,
  };
}

function mounted(content: string) {
  const env = setup(content);
  env.receive({ type: "bridgeReady", protocol: FILE_EDITOR_WEBVIEW_PROTOCOL });
  return env;
}

describe("FileEditorBridge", () => {
  test("mounts the model's document, or reports a WebView speaking another protocol", () => {
    const env = setup("one");
    env.receive({ type: "bridgeReady", protocol: FILE_EDITOR_WEBVIEW_PROTOCOL + 1 });
    expect(env.events.mismatch).toEqual([FILE_EDITOR_WEBVIEW_PROTOCOL + 1]);
    expect(env.sent).toEqual([]);
    env.receive({ type: "bridgeReady", protocol: FILE_EDITOR_WEBVIEW_PROTOCOL });
    expect(env.sent).toMatchObject([{ type: "mount", content: "one", filename: "file.ts" }]);
  });

  test("applies a sequence of edits with the file's own line separator, without echoing them back", () => {
    const env = mounted("a\r\nb");
    env.sendEdit({ from: 1, insert: "1" }, env.rev());
    env.sendEdit({ from: 4, insert: "\nc" }, env.rev());
    env.sendEdit({ from: 0, to: 1, insert: "A" }, env.rev());
    expect(env.model.getSnapshot()).toMatchObject({ content: "A1\r\nb\r\nc", status: "dirty" });
    expect(env.sent.map((m) => m.type)).toEqual(["mount"]);
  });

  test("drops an edit made against a document a reload replaced, then applies the next one", async () => {
    const env = mounted("one");
    const before = env.rev();
    env.sendEdit({ from: 3, insert: "!" }, before);
    await env.model.reload();
    expect(env.sent.at(-1)).toEqual({ type: "setDocument", content: "one", remoteRev: before + 1 });
    // Typed before the WebView saw the reload.
    env.sendEdit({ from: 4, insert: "?" }, before);
    expect(env.model.getSnapshot().content).toBe("one");
    env.setDoc("one");
    env.sendEdit({ from: 0, insert: ">" }, before + 1);
    expect(env.model.getSnapshot().content).toBe(">one");
  });

  test("asks for the whole document when an edit leaves the copies different, and ignores edits until it arrives", () => {
    const env = mounted("one");
    const rev = env.rev();
    env.receive({
      type: "edit",
      changes: ChangeSet.of({ from: 3, insert: "!" }, 3).toJSON(),
      baseRemoteRev: rev,
      length: 9,
    });
    expect(env.sent.at(-1)).toEqual({ type: "requestSync" });
    env.receive({
      type: "edit",
      changes: ChangeSet.of({ from: 0, insert: "x" }, 3).toJSON(),
      baseRemoteRev: rev,
      length: 4,
    });
    expect(env.model.getSnapshot().content).toBe("one");
    env.receive({ type: "sync", content: "one!\nmore", baseRemoteRev: rev });
    expect(env.model.getSnapshot().content).toBe("one!\nmore");
  });

  test("saves only once the checksum shows the model holds what the WebView shows", async () => {
    const env = mounted("one");
    const rev = env.rev();
    env.sendEdit({ from: 3, insert: "!" }, rev);
    env.receive({ type: "save", checksum: documentChecksum("one!?") });
    await Promise.resolve();
    expect(env.writes).toEqual([]);
    expect(env.sent.at(-1)).toEqual({ type: "requestSync" });
    env.receive({ type: "sync", content: "one!?", baseRemoteRev: rev });
    await Promise.resolve();
    expect(env.writes).toEqual(["one!?"]);
  });

  test("never saves over a conflict when the WebView asks to save", async () => {
    const env = mounted("one");
    env.sendEdit({ from: 3, insert: "!" }, env.rev());
    env.model.receiveFileObservation({
      status: "ready",
      file: { content: "theirs", hasBom: false, version: { ...version, size: 6 } },
    });
    expect(env.model.getSnapshot().status).toBe("conflict");
    env.receive({ type: "save", checksum: documentChecksum(env.doc()) });
    await Promise.resolve();
    expect(env.writes).toEqual([]);
  });

  test("flush waits for edits the WebView still holds, so an overwrite writes them", async () => {
    const env = mounted("one");
    env.sendEdit({ from: 3, insert: "!" }, env.rev());
    env.model.receiveFileObservation({
      status: "ready",
      file: { content: "theirs", hasBom: false, version: { ...version, size: 6 } },
    });
    let flushed = false;
    const flush = env.bridge.flush().then(() => (flushed = true));
    const request = env.sent.at(-1) as { type: "flush"; requestId: number };
    expect(request.type).toBe("flush");
    env.sendEdit({ from: 4, insert: "?" }, env.rev());
    await Promise.resolve();
    expect(flushed).toBe(false);
    env.receive({
      type: "flushed",
      requestId: request.requestId,
      checksum: documentChecksum(env.doc()),
    });
    await flush;
    await env.model.overwrite();
    expect(env.writes).toEqual(["one!?"]);
  });

  test("a flush the WebView never answers gives up after a bounded wait", async () => {
    const env = mounted("one");
    let flushed = false;
    const flush = env.bridge.flush().then(() => (flushed = true));
    env.clock.fireAll();
    await flush;
    expect(flushed).toBe(true);
  });
});
