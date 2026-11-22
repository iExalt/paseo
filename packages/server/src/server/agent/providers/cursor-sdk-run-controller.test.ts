import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunResult } from "@cursor/sdk";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CursorRunController } from "./cursor-sdk-run-controller.js";
import { CursorToolProcesses } from "./cursor-sdk-tool-processes.js";
import { CursorTurnJournal } from "./cursor-sdk-turn-journal.js";

const sessionId = "agent-controller";

function nativeRun(id: string) {
  const finished = Promise.withResolvers<RunResult>();
  let status: Run["status"] = "running";
  const run: Run = {
    id,
    agentId: sessionId,
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
    get status() {
      return status;
    },
    conversation: async () => [],
    async *stream() {
      const result = await finished.promise;
      const terminal = result.status === "finished" ? "FINISHED" : "CANCELLED";
      yield { type: "status", agent_id: sessionId, run_id: id, status: terminal };
    },
    wait: () => finished.promise,
    cancel: vi.fn(async (): Promise<void> => {}),
    steer: vi.fn<NonNullable<Run["steer"]>>(),
  };
  return {
    run,
    finish(statusValue: RunResult["status"] = "finished") {
      status = statusValue;
      finished.resolve({ id, status });
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(reconcile?: ConstructorParameters<typeof CursorRunController>[4]) {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-controller-"));
  roots.push(root);
  const journal = new CursorTurnJournal(root, sessionId);
  const events: AgentStreamEvent[] = [];
  const controller = new CursorRunController(
    sessionId,
    journal,
    (event) => events.push(event),
    () => undefined,
    reconcile,
  );
  const start = async (run: Run) =>
    controller.start(
      "start",
      { text: "start" },
      async (_input, bind) => {
        await bind(run.id);
        return run;
      },
      "message-start",
    );
  return { controller, events, journal, start };
}

test("keeps a late SDK send rejection outside accepted-turn lifecycle", async () => {
  const { controller, events, journal, start } = await fixture();
  const entered = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<Run>();
  const started = controller.start(
    "prompt",
    { text: "prompt" },
    async () => {
      entered.resolve();
      return admit.promise;
    },
    "rejected-message",
  );
  await entered.promise;
  const result = expect(started).rejects.toThrow("SDK refused the send");
  admit.reject(new Error("SDK refused the send"));
  await result;
  await vi.waitFor(async () =>
    expect((await journal.read())[0].terminal).toMatchObject({
      status: "error",
      message: "SDK refused the send",
    }),
  );
  expect(events).toEqual([]);
  const next = nativeRun("after-rejection");
  const accepted = await start(next.run);
  next.finish();
  await accepted.completion;
});

test("blocks a same-chat retry until unadmitted owner cleanup drains", async () => {
  const { controller, journal, events } = await fixture();
  const mutation = Promise.withResolvers<void>();
  const input = { text: "start" };
  const retry = nativeRun("retry-after-drain");
  const dispatch = vi.fn(async () => retry.run);
  await expect(
    controller.start(
      "start",
      input,
      async (_input, _bind, _stopped, execution) => {
        const generation = "bf918087-0dcb-429c-ac63-7ed805540f21";
        await execution.prepareOwner(generation);
        await execution.enroll({
          backend: "windows-job",
          generation,
          receipt: "not-dispatched",
          hostId: "a".repeat(64),
        });
        execution.deferUnadmittedCleanup(mutation.promise);
        throw new Error("Execution owner did not connect.");
      },
      "expired-admission",
    ),
  ).rejects.toThrow("Execution owner did not connect.");
  await expect(controller.start("retry", input, dispatch)).rejects.toThrow("still running");
  const [held] = await journal.read();
  expect(held.executionOwner).toBeDefined();
  expect(held.terminal).toBeUndefined();
  expect(dispatch).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  mutation.resolve();
  await controller.interrupt();
  const [released] = await journal.read();
  expect(released.executionOwner).toBeUndefined();
  expect(released.executionIntent).toBeUndefined();
  expect(released.terminal?.status).toBe("error");
  const accepted = await controller.start("retry", input, dispatch, "next-message");
  retry.finish();
  await accepted.completion;
  expect(dispatch).toHaveBeenCalledOnce();
});

test("failed cancellation retains the live run until natural completion", async () => {
  const { controller, start, events } = await fixture();
  const first = nativeRun("active");
  first.run.cancel = vi.fn(async () => {
    throw new Error("cancel rejected");
  });
  const turn = await start(first.run);
  await expect(controller.interrupt()).rejects.toThrow("cancel rejected");
  await expect(start(nativeRun("too-early").run)).rejects.toThrow("still running");
  first.finish();
  await turn.completion;
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  const second = nativeRun("next");
  const next = await start(second.run);
  second.finish();
  await next.completion;
});

test("bounded Stop holds the same cancel and keeps admission closed until native join", async () => {
  const { controller, start, journal } = await fixture();
  const first = nativeRun("active");
  const acknowledged = Promise.withResolvers<void>();
  first.run.cancel = vi.fn(() => acknowledged.promise);
  const turn = await start(first.run);
  vi.useFakeTimers();
  const stopping = controller.interrupt();
  const checked = expect(stopping).rejects.toThrow("could not confirm");
  await vi.advanceTimersByTimeAsync(1500);
  await checked;
  await expect(start(nativeRun("too-early").run)).rejects.toThrow("still running");
  const continuedStop = controller.interrupt();
  expect(first.run.cancel).toHaveBeenCalledTimes(1);
  first.finish("cancelled");
  expect((await journal.read())[0].joined).toBeUndefined();
  acknowledged.resolve();
  await continuedStop;
  expect((await turn.completion).canceled).toBe(true);
  expect((await journal.read())[0].joined).toBe(true);
});

test.each(["complete_delivered", "revert_to_followup"] as const)(
  "resolves native %s as exactly one owner",
  async (outcome) => {
    const { controller, journal, start } = await fixture();
    const first = nativeRun("active");
    vi.mocked(first.run.steer!).mockResolvedValue(outcome);
    const turn = await start(first.run);

    const delivered = await controller.steer("steer once", {
      expectedTurnId: turn.turnId,
      clientMessageId: "steer-message",
    });
    const accepted = outcome !== "revert_to_followup";
    expect(delivered).toEqual({ status: accepted ? "accepted" : "unavailable" });
    expect(first.run.steer).toHaveBeenCalledExactlyOnceWith("steer once");
    expect((await journal.read())[0].steers).toHaveLength(Number(accepted));
    first.finish();
    await turn.completion;
  },
);

test("observes an SDK-queued follow-up without submitting it again and Stop joins that run", async () => {
  const { controller, start } = await fixture();
  const first = nativeRun("current");
  const queued = nativeRun("native-follow-up");
  queued.run.cancel = vi.fn(async () => queued.finish("cancelled"));
  vi.mocked(first.run.steer!).mockResolvedValue({ outcome: "queued", run: queued.run });
  const turn = await start(first.run);
  await expect(controller.steer("steer", { expectedTurnId: turn.turnId })).resolves.toEqual({
    status: "accepted",
  });
  first.finish();
  await controller.interrupt();
  await expect(turn.completion).resolves.toMatchObject({ canceled: true });
  expect(queued.run.cancel).toHaveBeenCalledTimes(1);
});

test("does not transfer a canceled or unconfirmed steer to the Paseo queue", async () => {
  const { controller, journal, start } = await fixture();
  const first = nativeRun("active");
  const started = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<Awaited<ReturnType<NonNullable<Run["steer"]>>>>();
  vi.mocked(first.run.steer!).mockImplementation(async () => {
    started.resolve();
    return delivery.promise;
  });
  first.run.cancel = vi.fn(async () => {
    first.finish("cancelled");
    delivery.resolve("revert_to_followup");
  });
  const turn = await start(first.run);
  const pending = controller.steer("steer", {
    expectedTurnId: turn.turnId,
    clientMessageId: "unknown",
  });
  const rejected = expect(pending).rejects.toThrow("canceled the turn");
  await started.promise;
  await controller.interrupt();
  await rejected;
  expect((await journal.read())[0].steers).toEqual([]);
  await turn.completion;
});

test("an ambiguous timeout never requests fallback even if the SDK acknowledges late", async () => {
  const { controller, events, journal, start } = await fixture();
  const first = nativeRun("active");
  const started = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<Awaited<ReturnType<NonNullable<Run["steer"]>>>>();
  vi.mocked(first.run.steer!).mockImplementation(async () => {
    started.resolve();
    return delivery.promise;
  });
  const turn = await start(first.run);
  vi.useFakeTimers();
  const pending = controller.steer("late", {
    expectedTurnId: turn.turnId,
    clientMessageId: "late-message",
  });
  const rejected = expect(pending).rejects.toThrow("could not confirm steering");
  await started.promise;
  await vi.advanceTimersByTimeAsync(1500);
  await rejected;
  delivery.resolve("complete_delivered");
  first.finish();
  await turn.completion;
  expect(first.run.steer).toHaveBeenCalledExactlyOnceWith("late");
  expect((await journal.read())[0].steers).toHaveLength(1);
  expect(
    events.filter(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "late-message",
    ),
  ).toHaveLength(1);
});

test("an unnamed SDK-owned follow-up prevents subsequent delivery and Stop from claiming release", async () => {
  const { controller, journal, start } = await fixture();
  const first = nativeRun("active");
  vi.mocked(first.run.steer!).mockResolvedValue({ outcome: "queued" });
  const turn = await start(first.run);
  await expect(controller.steer("native-owned", { expectedTurnId: turn.turnId })).resolves.toEqual({
    status: "accepted",
  });
  first.finish();
  await expect(start(nativeRun("no-second-send").run)).rejects.toThrow("still running");
  await expect(controller.interrupt()).rejects.toThrow("did not identify its run");
  expect((await journal.read())[0]).toMatchObject({
    unresolvedNativeFollowUp: true,
    steers: [{ user: { text: "native-owned" } }],
  });
  expect((await journal.read())[0].joined).toBeUndefined();
});

test("joined local run still settles after an unacknowledged steering attempt", async () => {
  const { controller, journal, start } = await fixture();
  const first = nativeRun("active");
  const invoked = Promise.withResolvers<void>();
  vi.mocked(first.run.steer!).mockImplementation(() => {
    invoked.resolve();
    return new Promise(() => {});
  });
  const turn = await start(first.run);
  vi.useFakeTimers();
  const steering = expect(
    controller.steer("unknown", { expectedTurnId: turn.turnId }),
  ).rejects.toThrow("could not confirm steering");
  await invoked.promise;
  first.finish();
  await vi.advanceTimersByTimeAsync(3000);
  await steering;
  await expect(turn.completion).resolves.toMatchObject({ sessionId });
  expect((await journal.read())[0]).toMatchObject({ joined: true, steers: [] });
});

test("a failed native join after terminal metadata does not reopen admission", async () => {
  const { events, journal, start } = await fixture();
  const first = nativeRun("metadata-terminal");
  first.run.wait = vi.fn(async () => {
    throw new Error("join failed");
  });
  await start(first.run);
  first.finish();
  await vi.waitFor(() =>
    expect(
      events.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "error" &&
          event.item.message === "join failed",
      ),
    ).toBe(true),
  );
  expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  expect((await journal.read())[0].joined).toBeUndefined();
  await expect(start(nativeRun("must-not-start").run)).rejects.toThrow("still running");
});

test("an unobserved shell keeps Stop unconfirmed and does not settle the foreground turn", async () => {
  const { controller, events, journal, start } = await fixture();
  const first = nativeRun("unobserved-shell");
  const emitted = Promise.withResolvers<void>();
  const underlyingStream = first.run.stream.bind(first.run);
  first.run.stream = async function* () {
    yield {
      type: "tool_call",
      agent_id: sessionId,
      run_id: first.run.id,
      call_id: "shell-without-local-owner",
      name: "shell",
      status: "running",
    };
    emitted.resolve();
    yield* underlyingStream();
  };
  first.run.cancel = vi.fn(async () => first.finish("cancelled"));
  await start(first.run);
  await emitted.promise;
  vi.useFakeTimers();
  const rejected = expect(controller.interrupt()).rejects.toThrow("could not confirm");
  await vi.advanceTimersByTimeAsync(1500);
  await rejected;
  expect((await journal.read())[0].joined).toBeUndefined();
  expect(events.some((event) => event.type === "turn_canceled")).toBe(false);
  expect(
    events.some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "error" &&
        /could not verify/.test(event.item.message),
    ),
  ).toBe(true);
  await expect(start(nativeRun("must-not-start").run)).rejects.toThrow("still running");
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "counts successful shell groups without sharing them between admission scopes",
  async () => {
    const first = new CursorToolProcesses();
    const second = new CursorToolProcesses();
    first.observeShellCall("same-call");
    first.observeShellCall("same-call");
    second.observeShellCall("separate-call");
    const launchShell = () =>
      spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    const unowned = launchShell();
    const owned = first.scope(launchShell);
    await Promise.all([once(unowned, "exit"), once(owned, "exit")]);
    expect(first.canConfirmShellOwnership).toBe(true);
    expect(second.canConfirmShellOwnership).toBe(false);
    first.observeShellCall("another-call");
    expect(first.canConfirmShellOwnership).toBe(false);
    const sibling = first.scope(launchShell);
    await once(sibling, "exit");
    expect(first.canConfirmShellOwnership).toBe(true);
    await first.waitForKnownGroupsToExit();
  },
);

test("Stop during the durable successful terminal transition waits for the owned domain", async () => {
  const enteringCommit = Promise.withResolvers<void>();
  const finishCommit = Promise.withResolvers<void>();
  const waitingOnTools = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const { controller, events, journal } = await fixture(async (record, proof) => {
    expect(proof).toBe("completed-writer");
    enteringCommit.resolve();
    await finishCommit.promise;
    record.joined = true;
    await journal.save(record);
  });
  const native = nativeRun("run-for-stop-race");
  native.run.cancel = vi.fn(async () => {
    throw new Error("SDK channel is already closed");
  });
  const active = await controller.start(
    "original",
    { text: "original" },
    async (_input, _bind, _guard, execution) => {
      await execution.enroll({
        backend: "linux-systemd",
        hostId: "a".repeat(64),
        bootId: "before",
        cgroupNamespace: "cgroup:[12]",
        mountNamespace: "mnt:[14]",
        cgroupRootIdentity: "12:13",
        cgroupIdentity: "12:15",
        unit: "paseo-run-45262816-26a6-4258-9e2e-7059a6198c39.service",
        invocation: "a".repeat(32),
        cgroup: "/cgroup",
      });
      await execution.bindRun(native.run.id);
      execution.attachFinish(async (waitForTools) => {
        if (!waitForTools) return;
        waitingOnTools.resolve();
        await exited.promise;
      });
      return native.run;
    },
  );
  native.finish();
  await enteringCommit.promise;
  const stop = controller.interrupt();
  finishCommit.resolve();
  await waitingOnTools.promise;
  expect(events.some(({ type }) => type === "turn_completed")).toBe(false);
  await expect(controller.start("next", { text: "next" }, async () => native.run)).rejects.toThrow(
    "still running",
  );
  exited.resolve();
  await Promise.all([stop, active.completion]);
  expect(events.filter(({ type }) => type === "turn_completed")).toHaveLength(1);
  expect(native.run.cancel).not.toHaveBeenCalled();
  expect((await journal.read())[0]).toMatchObject({ joined: true, ownerStopPending: false });
});
