import { ChangeSet, Text } from "@codemirror/state";
import type { FileEditorClock, FileEditorModel } from "../model";
import type { EditorVisualTheme } from "../visual-theme";
import {
  documentChecksum,
  FILE_EDITOR_WEBVIEW_PROTOCOL,
  type FileEditorHostMessage,
  type FileEditorWebViewMessage,
} from "./protocol";

const FLUSH_TIMEOUT_MS = 1_000;

const systemClock: FileEditorClock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

function toText(content: string): Text {
  return Text.of(content.split(/\r\n?|\n/));
}

export interface FileEditorBridgeEvents {
  /** The WebView speaks another protocol version; the host shows the read-only view. */
  onProtocolMismatch(version: number): void;
  onEditorReady(): void;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}

/**
 * Keeps the model and the WebView's document in step. The model stays the source of
 * truth; the WebView sends ChangeSets, applied here to `mirror`, a copy of its `\n`
 * document, and the model receives the result joined with the file's own line separator.
 */
export class FileEditorBridge {
  private readonly model: FileEditorModel;
  private readonly send: (message: FileEditorHostMessage) => void;
  private readonly events: FileEditorBridgeEvents;
  private readonly clock: FileEditorClock;
  private mirror: Text;
  /** Model content the bridge last wrote or sent; anything else is a remote change. */
  private lastContent: string;
  private remoteRev = 0;
  private mounted = false;
  private awaitingSync = false;
  private saveAfterSync = false;
  private nextFlushId = 1;
  private readonly flushes = new Map<
    number,
    { resolve(): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly unsubscribe: () => void;

  constructor(input: {
    model: FileEditorModel;
    send(message: FileEditorHostMessage): void;
    events: FileEditorBridgeEvents;
    clock?: FileEditorClock;
  }) {
    this.model = input.model;
    this.send = input.send;
    this.events = input.events;
    this.clock = input.clock ?? systemClock;
    this.lastContent = this.model.getSnapshot().content;
    this.mirror = toText(this.lastContent);
    this.unsubscribe = this.model.subscribe(this.handleModelChange);
  }

  /** Answer a WebView message; `view` carries what the mount needs. */
  receive(
    message: FileEditorWebViewMessage,
    view: { filename: string; theme: EditorVisualTheme; vim: boolean },
  ): void {
    switch (message.type) {
      case "bridgeReady":
        if (message.protocol !== FILE_EDITOR_WEBVIEW_PROTOCOL) {
          this.events.onProtocolMismatch(message.protocol);
          return;
        }
        this.mount(view);
        return;
      case "editorReady":
        this.events.onEditorReady();
        return;
      case "edit":
        this.receiveEdit(message);
        return;
      case "sync":
        if (message.baseRemoteRev !== this.remoteRev) return;
        this.awaitingSync = false;
        this.mirror = toText(message.content);
        this.writeMirror();
        if (this.saveAfterSync) {
          this.saveAfterSync = false;
          void this.model.save();
        }
        this.settleFlushes();
        return;
      case "flushed":
        if (this.checksumMatches(message.checksum)) this.settleFlush(message.requestId);
        // Otherwise the flush settles when the requested sync arrives.
        return;
      case "save":
        if (this.checksumMatches(message.checksum)) void this.model.save();
        else this.saveAfterSync = true;
        return;
      case "cursor":
        this.events.onCursorChange({ line: message.line, column: message.column });
        return;
      case "vimMode":
        this.events.onVimModeChange(message.mode);
        return;
    }
  }

  /**
   * Resolves once every edit the WebView holds has reached the model, or after a bounded
   * wait so a stuck renderer cannot hold an overwrite or tab close forever.
   */
  flush(): Promise<void> {
    if (!this.mounted) return Promise.resolve();
    const requestId = this.nextFlushId++;
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => this.settleFlush(requestId), FLUSH_TIMEOUT_MS);
      this.flushes.set(requestId, { resolve, timer });
      this.send({ type: "flush", requestId });
    });
  }

  /** The WebView reloaded: its document is gone until the next mount. */
  reset(): void {
    this.mounted = false;
    this.awaitingSync = false;
    this.saveAfterSync = false;
    this.settleFlushes();
  }

  dispose(): void {
    this.reset();
    this.unsubscribe();
  }

  private mount(view: { filename: string; theme: EditorVisualTheme; vim: boolean }): void {
    // A fresh WebView document starts a new revision, so edits a dead renderer sent
    // before reloading cannot apply to the new one.
    this.remoteRev += 1;
    this.lastContent = this.model.getSnapshot().content;
    this.mirror = toText(this.lastContent);
    this.awaitingSync = false;
    this.mounted = true;
    this.send({ type: "mount", content: this.lastContent, remoteRev: this.remoteRev, ...view });
  }

  private receiveEdit(message: Extract<FileEditorWebViewMessage, { type: "edit" }>): void {
    // Made against a document the host has since replaced, or after drift was noticed.
    if (message.baseRemoteRev !== this.remoteRev || this.awaitingSync) return;
    let next: Text | null = null;
    try {
      next = ChangeSet.fromJSON(message.changes).apply(this.mirror);
    } catch {
      next = null;
    }
    if (!next || next.length !== message.length) {
      this.requestSync();
      return;
    }
    this.mirror = next;
    this.writeMirror();
  }

  private requestSync(): void {
    this.awaitingSync = true;
    this.send({ type: "requestSync" });
  }

  private writeMirror(): void {
    const { lineSeparator } = this.model.getSnapshot();
    this.lastContent = this.mirror.sliceString(0, undefined, lineSeparator);
    this.model.edit(this.lastContent);
  }

  private checksumMatches(checksum: string): boolean {
    if (this.awaitingSync) return false;
    if (documentChecksum(this.mirror.toString()) === checksum) return true;
    this.requestSync();
    return false;
  }

  private settleFlush(requestId: number): void {
    const flush = this.flushes.get(requestId);
    if (!flush) return;
    this.flushes.delete(requestId);
    this.clock.clearTimeout(flush.timer);
    flush.resolve();
  }

  private settleFlushes(): void {
    for (const requestId of this.flushes.keys()) this.settleFlush(requestId);
  }

  private handleModelChange = (): void => {
    const { content } = this.model.getSnapshot();
    if (content === this.lastContent) return;
    // Reload, a clean external change, or anything else that did not come from the WebView.
    this.lastContent = content;
    this.mirror = toText(content);
    this.remoteRev += 1;
    this.awaitingSync = false;
    if (this.mounted) this.send({ type: "setDocument", content, remoteRev: this.remoteRev });
  };
}
