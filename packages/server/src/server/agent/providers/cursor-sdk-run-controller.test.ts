import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunResult } from "@cursor/sdk";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CursorRunController } from "./cursor-sdk-run-controller.js";
import { mapCursorUsage } from "./cursor-sdk-telemetry.js";
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
    expect(delivered).toEqual(
      accepted
        ? { status: "accepted", providerMessageId: "steer-message" }
        : { status: "unavailable" },
    );
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
  await expect(
    controller.steer("steer", { expectedTurnId: turn.turnId, clientMessageId: "steer-id" }),
  ).resolves.toEqual({ status: "accepted", providerMessageId: "steer-id" });
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
    providerMessageId: expect.stringContaining(":steer:"),
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

test("keeps compaction and ordinary steering separate and settles a canceled summary", async () => {
  const { controller, events, journal } = await fixture();
  const startObserved = async (prompt: string) => {
    const run = nativeRun(prompt);
    const started = Promise.withResolvers<void>();
    const stream = run.run.stream.bind(run.run);
    run.run.stream = async function* () {
      started.resolve();
      if (prompt === "/compact") {
        yield { type: "summary", run_id: run.run.id, agent_id: sessionId, status: "running" };
      }
      yield* stream();
    };
    run.run.cancel = vi.fn(async () => run.finish("cancelled"));
    const turn = await controller.start(prompt, { text: prompt }, async () => run.run);
    await started.promise;
    return { run, turn };
  };

  const summary = await startObserved("/compact");
  await expect(
    controller.steer("Continue work", { expectedTurnId: summary.turn.turnId }),
  ).resolves.toEqual({ status: "unavailable" });
  expect(summary.run.run.steer).not.toHaveBeenCalled();
  await controller.interrupt();
  expect((await summary.turn.completion).canceled).toBe(true);
  expect(
    events.some((event) => event.type === "timeline" && event.item.type === "compaction"),
  ).toBe(false);
  expect((await journal.read()).find((item) => item.id === summary.turn.turnId)?.compact).toBe(
    true,
  );

  const next = await startObserved("Continue work");
  await expect(controller.steer("/compact", { expectedTurnId: next.turn.turnId })).resolves.toEqual(
    { status: "unavailable" },
  );
  expect(next.run.run.steer).not.toHaveBeenCalled();
  next.run.finish();
  expect((await next.turn.completion).canceled).toBeFalsy();
});

test("reports per-step context window from latest model-call-completed instead of cumulative turn sum", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-controller-context-"));
  roots.push(root);
  const journal = new CursorTurnJournal(root, sessionId);
  const events: AgentStreamEvent[] = [];
  const controller = new CursorRunController(
    sessionId,
    journal,
    (event) => events.push(event),
    mapCursorUsage,
  );
  const finished = Promise.withResolvers<RunResult>();
  const run: Run = {
    id: "run-multistep",
    agentId: sessionId,
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
    get status() {
      return "finished" as const;
    },
    conversation: async () => [],
    async *stream() {
      yield {
        type: "tool_call",
        agent_id: sessionId,
        run_id: "run-multistep",
        call_id: "c1",
        name: "read",
        status: "completed",
        args: { path: "a.ts" },
        result: { status: "success", value: { content: "ok" } },
      };
      await finished.promise;
    },
    wait: () => finished.promise,
    cancel: vi.fn(async () => {}),
  };

  let executionRef: Parameters<Parameters<CursorRunController["start"]>[2]>[3] | undefined;
  const started = await controller.start(
    "multi-step",
    { text: "multi-step" },
    async (_input, bind, _throwIfStopped, execution) => {
      executionRef = execution;
      execution.setContextWindowMaxTokens(300_000);
      await bind(run.id);
      return run;
    },
    "msg-multistep",
  );
  executionRef!.onModelCallCompleted({ inputTokens: 10_000, outputTokens: 500 });
  executionRef!.onModelCallCompleted({ inputTokens: 14_000, outputTokens: 800 });
  finished.resolve({
    id: run.id,
    status: "finished",
    usage: {
      inputTokens: 24_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
      outputTokens: 1_300,
      totalTokens: 25_300,
    },
  });
  const result = await started.completion;
  expect(result.usage).toEqual({
    inputTokens: 24_000,
    cachedInputTokens: 10_000,
    cacheWriteTokens: 0,
    outputTokens: 1_300,
    totalTokens: 25_300,
    contextWindowUsedTokens: 14_800,
    contextWindowMaxTokens: 300_000,
  });
  const midTurnContext = events
    .filter((event) => event.type === "usage_updated")
    .map((event) => event.usage.contextWindowUsedTokens);
  expect(midTurnContext).toEqual([10_500, 14_800]);
  const saved = (await journal.read())[0];
  expect(saved?.lastUsage?.contextWindowUsedTokens).toBe(14_800);
  expect(saved?.lastUsage?.contextWindowMaxTokens).toBe(300_000);
});

test("uses single-step fallback only without tool calls, and clears context on auto and manual compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-controller-compact-"));
  roots.push(root);
  const journal = new CursorTurnJournal(root, sessionId);
  const events: AgentStreamEvent[] = [];
  const controller = new CursorRunController(
    sessionId,
    journal,
    (event) => events.push(event),
    mapCursorUsage,
  );

  // 1. Single-step turn with no model-call-completed and 0 tools falls back cleanly.
  const singleResult = await (
    await controller.start(
      "hello",
      { text: "hello" },
      async (_input, bind, _throwIfStopped, execution) => {
        execution.setContextWindowMaxTokens(300_000);
        await bind("run-single");
        return {
          id: "run-single",
          agentId: sessionId,
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
          status: "finished",
          conversation: async () => [],
          async *stream() {},
          wait: async () => ({
            id: "run-single",
            status: "finished",
            usage: {
              inputTokens: 2_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 200,
              totalTokens: 2_200,
            },
          }),
          cancel: async () => {},
        };
      },
    )
  ).completion;
  expect(singleResult.usage?.contextWindowUsedTokens).toBe(2_200);

  // 2. Multi-step turn (tool call present) with no model-call-completed does not overcount.
  const multiNoDelta = await (
    await controller.start(
      "tools",
      { text: "tools" },
      async (_input, bind, _throwIfStopped, execution) => {
        execution.setContextWindowMaxTokens(300_000);
        await bind("run-tools-nodelta");
        return {
          id: "run-tools-nodelta",
          agentId: sessionId,
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
          status: "finished",
          conversation: async () => [],
          async *stream() {
            yield {
              type: "tool_call",
              agent_id: sessionId,
              run_id: "run-tools-nodelta",
              call_id: "t1",
              name: "read",
              status: "completed",
              args: { path: "x.ts" },
              result: { status: "success", value: { content: "x" } },
            };
          },
          wait: async () => ({
            id: "run-tools-nodelta",
            status: "finished",
            usage: {
              inputTokens: 450_000,
              cacheReadTokens: 400_000,
              cacheWriteTokens: 0,
              outputTokens: 5_000,
              totalTokens: 455_000,
            },
          }),
          cancel: async () => {},
        };
      },
    )
  ).completion;
  expect(multiNoDelta.usage?.contextWindowUsedTokens).toBeUndefined();

  // 3. Auto-compaction followed by cancellation before next model call keeps context cleared.
  events.length = 0;
  const autoCompactCancel = await (
    await controller.start(
      "auto-compact",
      { text: "auto-compact" },
      async (_input, bind, _throwIfStopped, execution) => {
        execution.setContextWindowMaxTokens(300_000);
        await bind("run-autocompact");
        return {
          id: "run-autocompact",
          agentId: sessionId,
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
          status: "cancelled",
          conversation: async () => [],
          async *stream() {
            execution.onModelCallCompleted({ inputTokens: 280_000, outputTokens: 1_000 });
            yield {
              type: "summary",
              agent_id: sessionId,
              run_id: "run-autocompact",
              status: "completed",
            };
          },
          wait: async () => ({
            id: "run-autocompact",
            status: "cancelled",
            usage: {
              inputTokens: 280_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 1_000,
              totalTokens: 281_000,
            },
          }),
          cancel: async () => {},
        };
      },
    )
  ).completion;
  expect(autoCompactCancel.usage?.contextWindowUsedTokens).toBeUndefined();
  expect(
    events.some((event) => event.type === "usage_updated" && event.clearContextWindowUsed === true),
  ).toBe(true);

  // 4. Manual /compact disables single-step fallback and clears stale context.
  events.length = 0;
  const manualCompact = await (
    await controller.start(
      "/compact",
      { text: "/compact" },
      async (_input, bind, _throwIfStopped, execution) => {
        execution.setContextWindowMaxTokens(300_000);
        await bind("run-manual-compact");
        return {
          id: "run-manual-compact",
          agentId: sessionId,
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
          status: "finished",
          conversation: async () => [],
          async *stream() {},
          wait: async () => ({
            id: "run-manual-compact",
            status: "finished",
            result: "summary",
            usage: {
              inputTokens: 275_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 2_000,
              totalTokens: 277_000,
            },
          }),
          cancel: async () => {},
        };
      },
    )
  ).completion;
  expect(manualCompact.usage?.contextWindowUsedTokens).toBeUndefined();
  expect(
    events.some((event) => event.type === "usage_updated" && event.clearContextWindowUsed === true),
  ).toBe(true);
});

test("leaves lastUsage undefined on failed/cancelled turns without usage and clears stale context on cancelled multi-step turn without model-call-completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-controller-empty-turn-"));
  roots.push(root);
  const journal = new CursorTurnJournal(root, sessionId);
  const events: AgentStreamEvent[] = [];
  const controller = new CursorRunController(
    sessionId,
    journal,
    (event) => events.push(event),
    mapCursorUsage,
  );

  // Turn 1 sets valid usage and context occupancy.
  await (
    await controller.start(
      "turn-1",
      { text: "turn-1" },
      async (_input, bind, _throwIfStopped, execution) => {
        execution.setContextWindowMaxTokens(300_000);
        await bind("run-t1");
        return {
          id: "run-t1",
          agentId: sessionId,
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
          status: "finished",
          conversation: async () => [],
          async *stream() {
            execution.onModelCallCompleted({ inputTokens: 10_000, outputTokens: 500 });
            yield { type: "status", agent_id: sessionId, run_id: "run-t1", status: "FINISHED" };
          },
          wait: async () => ({
            id: "run-t1",
            status: "finished",
            usage: {
              inputTokens: 10_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 500,
              totalTokens: 10_500,
            },
          }),
          cancel: async () => {},
        };
      },
    )
  ).completion;

  // Turn 2 fails before any LLM usage on a 300k model: must not persist { contextWindowMaxTokens }.
  await expect(
    (
      await controller.start(
        "turn-2-fail",
        { text: "turn-2-fail" },
        async (_input, bind, _throwIfStopped, execution) => {
          execution.setContextWindowMaxTokens(300_000);
          await bind("run-t2-fail");
          return {
            id: "run-t2-fail",
            agentId: sessionId,
            supports: () => true,
            unsupportedReason: () => undefined,
            onDidChangeStatus: () => () => {},
            status: "error",
            conversation: async () => [],
            async *stream() {},
            wait: async () => ({
              id: "run-t2-fail",
              status: "error",
              error: { message: "boom" },
            }),
            cancel: async () => {},
          };
        },
      )
    ).completion,
  ).rejects.toThrow("boom");

  const recordsAfterFail = await journal.read();
  expect(recordsAfterFail[1]?.lastUsage).toBeUndefined();

  // Turn 3 cancels after tool use + token usage with no model-call-completed: must clear stale context.
  events.length = 0;
  const cancelled = await (
    await controller.start(
      "turn-3-cancel",
      { text: "turn-3-cancel" },
      async (_input, bind, _throwIfStopped, execution) => {
        execution.setContextWindowMaxTokens(300_000);
        await bind("run-t3-cancel");
        return {
          id: "run-t3-cancel",
          agentId: sessionId,
          supports: () => true,
          unsupportedReason: () => undefined,
          onDidChangeStatus: () => () => {},
          status: "cancelled",
          conversation: async () => [],
          async *stream() {
            yield {
              type: "tool_call",
              agent_id: sessionId,
              run_id: "run-t3-cancel",
              call_id: "t-cancel",
              name: "read",
              status: "completed",
              args: { path: "f.ts" },
              result: { status: "success", value: { content: "f" } },
            };
          },
          wait: async () => ({
            id: "run-t3-cancel",
            status: "cancelled",
            usage: {
              inputTokens: 25_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 300,
              totalTokens: 25_300,
            },
          }),
          cancel: async () => {},
        };
      },
    )
  ).completion;
  expect(cancelled.usage?.contextWindowUsedTokens).toBeUndefined();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "usage_updated",
      clearContextWindowUsed: true,
    }),
  );
});
