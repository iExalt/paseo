import { readlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { inspectExecutionOwner, type ExecutionOwner } from "./execution-owner.js";
import { startLinuxExecutionOwner } from "./linux-systemd-owner.js";
import { startWindowsExecutionOwner } from "./windows-job-owner.js";
import { createOwnerChannel, ownerDeferred } from "./owner-channel.js";

type Handler = Parameters<typeof createOwnerChannel>[2];
type Channel = ReturnType<typeof createOwnerChannel>;

export class UnadmittedExecutionError extends Error {
  constructor(
    error: unknown,
    readonly drained: Promise<void>,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export type EnrollExecutionOwner = (
  owner: ExecutionOwner,
  assertLaunchAvailable: () => void,
) => Promise<void>;

export interface OwnedProcess {
  owner: ExecutionOwner;
  channel: Channel;
  waitForExit: () => Promise<void>;
}

export async function waitForExecutionOwner(owner: ExecutionOwner): Promise<void> {
  let interval = 80;
  for (;;) {
    const state = await inspectExecutionOwner(owner);
    if (state === "released") return;
    await delay(interval, undefined, { ref: false });
    interval = Math.min(interval * 2, 1000);
  }
}

async function currentNamespaces(): Promise<string[]> {
  if (process.platform !== "linux") return [];
  return Promise.all(
    ["net", "pid", "mnt", "user", "cgroup"].map((name) => readlink(`/proc/self/ns/${name}`)),
  );
}

export async function connectOwnedProcess(handle: Handler): Promise<Channel> {
  const channel = createOwnerChannel(process.stdin, process.stdout, handle);
  await channel.request("hello", { pid: process.pid, namespaces: await currentNamespaces() });
  return channel;
}

/** Start a worker over inherited pipes and commit its domain before enabling dispatch. */
export async function openOwnedProcess(
  entry: string,
  home: string,
  generation: string,
  enroll: EnrollExecutionOwner,
  handle: Handler,
): Promise<OwnedProcess> {
  const namespaces = await currentNamespaces();
  const args = [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry];
  const launch =
    process.platform === "win32"
      ? await startWindowsExecutionOwner(process.execPath, args, home, generation)
      : await startLinuxExecutionOwner(generation, "/usr/bin/env", [
          "-i",
          "ELECTRON_RUN_AS_NODE=1",
          process.execPath,
          ...args,
        ]);
  const ready = ownerDeferred<ExecutionOwner>();
  const timeout = AbortSignal.timeout(6_000);
  timeout.addEventListener(
    "abort",
    () => ready.reject(new Error("Execution owner did not connect.")),
    { once: true },
  );
  const { child } = launch;
  child.once("error", () => ready.reject(new Error("Execution owner did not start.")));
  if (!child.stdout || !child.stdin) throw new Error("Execution owner has no private pipes.");
  let authorized = false;
  let sawHello = false;
  let enrollment: Promise<void> | undefined;
  const channel = createOwnerChannel(child.stdout, child.stdin, async (method, input) => {
    if (method !== "hello" || sawHello) {
      if (!authorized) throw new Error("Execution owner has not enrolled.");
      return handle(method, input);
    }
    sawHello = true;
    try {
      const { pid, namespaces: actual } = input as { pid: number; namespaces: string[] };
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        JSON.stringify(actual) !== JSON.stringify(namespaces)
      ) {
        throw new Error("Execution owner uses a different host namespace.");
      }
      const attestation = await launch.attest(pid);
      const owner = "owner" in attestation ? attestation.owner : attestation;
      const assertLaunchAvailable = () => {
        if (timeout.aborted || !channel.connected)
          throw new Error("Execution owner disconnected during enrollment.");
      };
      assertLaunchAvailable();
      enrollment = Promise.resolve().then(() => {
        assertLaunchAvailable();
        return enroll(owner, assertLaunchAvailable);
      });
      await enrollment;
      assertLaunchAvailable();
      authorized = true;
      if ("watchWorker" in attestation) {
        void attestation.watchWorker(() => channel.connected, channel.close);
      }
      ready.resolve(owner);
    } catch (error) {
      ready.reject(error);
      throw error;
    }
  });
  void channel.whenClosed.then(() => ready.reject(new Error("Execution owner disconnected.")));
  try {
    const owner = await ready.promise;
    return { owner, channel, waitForExit: () => waitForExecutionOwner(owner) };
  } catch (error) {
    channel.close();
    const abandon = launch.abandon();
    if (enrollment) {
      // Return the failed admission promptly. The caller must retain its turn
      // until the callback finishes any already accepted native mutation.
      const drained = Promise.allSettled([enrollment, abandon]).then(() => undefined);
      throw new UnadmittedExecutionError(error, drained);
    }
    await abandon;
    throw error;
  }
}
