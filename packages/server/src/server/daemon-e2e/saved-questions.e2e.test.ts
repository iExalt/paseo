import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";

test.each([false, true])(
  "saved async questions survive cold daemon restart and answer/dismiss (dismiss=%s)",
  async (dismiss) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-saved-question-process-"));
    const children: ChildProcess[] = [];
    let client: DaemonClient | undefined;
    async function start() {
      const child = fork(
        fileURLToPath(new URL("../test-utils/saved-question-daemon.ts", import.meta.url)),
        [root],
        {
          execArgv: ["--conditions=source", "--import", "tsx"],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      let output = "";
      child.stdout?.on("data", (s) => {
        output += s;
      });
      child.stderr?.on("data", (s) => {
        output += s;
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        const ready = await Promise.race([
          once(child, "message").then(([m]) => m as { port: number }),
          once(child, "exit").then(() => {
            throw new Error(`Fixture exited: ${output}`);
          }),
        ]);
        client = new DaemonClient({ url: `ws://127.0.0.1:${ready.port}/ws`, appVersion: "0.23.1" });
        await client.connect();
        await client.fetchAgents({ subscribe: {} });
        return child;
      } finally {
        clearTimeout(timeout);
      }
    }
    async function stop(child: ChildProcess) {
      await client?.close();
      const exited = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.send("stop");
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    try {
      let child = await start();
      const agent = await client!.createAgent({ provider: "codex", cwd: root, model: "gpt-5.4" });
      await client!.sendMessage(agent.id, "ask");
      await expect
        .poll(async () => (await client!.fetchAgent(agent.id))?.agent)
        .toMatchObject({
          status: "idle",
          pendingPermissions: [{ id: "permission-saved-question" }],
        });
      await stop(child);
      child = await start();
      // No prompt or explicit reopen: the cold stored snapshot must expose the question.
      expect((await client!.fetchAgent(agent.id))?.agent.pendingPermissions).toMatchObject([
        { id: "permission-saved-question" },
      ]);
      expect((await readFile(join(root, "prompts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(
        1,
      );
      await client!.respondToPermissionAndWait(
        agent.id,
        "permission-saved-question",
        dismiss
          ? { behavior: "deny" }
          : { behavior: "allow", updatedInput: { answers: { "Question 1": "Green" } } },
      );
      await expect
        .poll(async () => (await client!.fetchAgent(agent.id))?.agent.pendingPermissions)
        .toEqual([]);
      await stop(child);
      child = await start();
      expect((await client!.fetchAgent(agent.id))?.agent.pendingPermissions).toEqual([]);
      const prompts = (await readFile(join(root, "prompts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(prompts).toHaveLength(dismiss ? 1 : 2);
      if (!dismiss)
        expect(prompts[1]).toMatchObject({
          thread: "thread-1",
          prompt: expect.stringContaining("Which color?\nGreen"),
        });
      await stop(child);
    } finally {
      await client?.close();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
