import type { Readable, Writable } from "node:stream";
import { encodeFrame, FrameDecoder } from "../../../terminal/terminal-worker-frames.js";

interface Reply {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export function ownerDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function connectionError(): Error {
  return new Error("Execution owner connection closed.");
}

/** One connection per owner generation. No request survives disconnect. */
export function createOwnerChannel(
  readable: Readable,
  writable: Writable,
  handle: (method: string, input: unknown) => Promise<unknown>,
) {
  const pending = new Map<number, Reply>();
  let nextId = 0;
  let connected = true;
  const closed = ownerDeferred<void>();
  function send(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const frame = encodeFrame(value);
      writable.write(frame, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function receive(raw: unknown): void {
    if (typeof raw !== "object" || raw === null || !("id" in raw) || typeof raw.id !== "number") {
      close();
      return;
    }
    const id = raw.id;
    if ("method" in raw && typeof raw.method === "string") {
      void handle(raw.method, "input" in raw ? raw.input : undefined)
        .then(
          (value) => send({ id, value }),
          () => send({ id, error: true }),
        )
        .catch(() => close());
      return;
    }
    const reply = pending.get(id);
    if (!reply) {
      close();
      return;
    }
    pending.delete(id);
    if ("error" in raw) reply.reject(new Error("Execution owner request failed."));
    else reply.resolve("value" in raw ? raw.value : undefined);
  }
  const decoder = new FrameDecoder();
  readable.on("data", (data: Buffer) => {
    try {
      for (const frame of decoder.push(data)) receive(frame);
    } catch {
      close();
    }
  });
  function close() {
    if (!connected) return;
    connected = false;
    readable.destroy();
    writable.destroy();
    for (const request of pending.values()) request.reject(connectionError());
    pending.clear();
    closed.resolve();
  }
  readable.once("end", close);
  readable.once("error", close);
  readable.once("close", close);
  writable.once("error", close);
  writable.once("close", close);
  return {
    whenClosed: closed.promise,
    get connected() {
      return connected && !readable.destroyed;
    },
    async request<T>(method: string, input?: unknown): Promise<T> {
      if (!connected || readable.destroyed) throw connectionError();
      const id = ++nextId;
      const reply = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      try {
        const written = send({ id, method, input }).catch(() => {
          throw new Error("Unable to send execution-owner request.");
        });
        const [value] = await Promise.all([reply, written]);
        return value as T;
      } finally {
        pending.delete(id);
      }
    },
    close,
  };
}
