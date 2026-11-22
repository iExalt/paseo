import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readlink } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createOwnerChannel } from "./owner-channel.js";
import { openOwnedProcess, UnadmittedExecutionError } from "./owned-process.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("./linux-systemd-owner.js", async (load) => ({
  ...(await load<typeof import("./linux-systemd-owner.js")>()),
  startLinuxExecutionOwner: launch,
}));
vi.mock("./windows-job-owner.js", async (load) => ({
  ...(await load<typeof import("./windows-job-owner.js")>()),
  startWindowsExecutionOwner: launch,
}));

afterEach(() => {
  vi.restoreAllMocks();
  launch.mockReset();
});

test.each(["expired", "disconnected"] as const)(
  "drains a started enrollment mutation when launch is %s",
  async (failure) => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const generation = randomUUID();
    const owner = {
      backend: "windows-job" as const,
      generation,
      hostId: "a".repeat(64),
      receipt: "synthetic receipt",
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout });
    const abandon = vi.fn(async () => {});
    launch.mockResolvedValue({ child, attest: async () => owner, abandon });
    const peer = createOwnerChannel(stdin, stdout, async () => {});
    const namespaces =
      process.platform === "linux"
        ? await Promise.all(
            ["net", "pid", "mnt", "user", "cgroup"].map((name) =>
              readlink(`/proc/self/ns/${name}`),
            ),
          )
        : [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const commit = vi.fn();
    const finishedMutation = vi.fn();
    const open = openOwnedProcess(
      "probe.js",
      "synthetic home",
      generation,
      async (_, assertCurrent) => {
        entered.resolve();
        await release.promise;
        finishedMutation();
        assertCurrent();
        commit();
      },
      async () => {},
    );
    const failureInfo = open.catch((error: unknown) => error);
    const hello = peer.request("hello", { pid: 12345, namespaces }).catch(() => undefined);
    await entered.promise;
    try {
      if (failure === "expired") deadline.abort();
      else peer.close();
      const error = await failureInfo;
      expect(error).toBeInstanceOf(UnadmittedExecutionError);
      if (!(error instanceof UnadmittedExecutionError)) throw new Error("Missing admission guard.");
      const drained = vi.fn();
      void error.drained.then(drained);
      await Promise.resolve();
      expect(abandon).toHaveBeenCalledOnce();
      expect(drained).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      release.resolve();
      await error.drained;
      expect(finishedMutation).toHaveBeenCalledOnce();
      expect(drained).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      peer.close();
      await hello;
    }
  },
);
