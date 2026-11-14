import { FakeRewindSession, REWIND_TEST_CAPABILITIES } from "./agent/rewind/test-rewind-session.js";
import { test } from "vitest";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { createDaemonTestContext } from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import type { AgentPromptInput } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
type CliProcess = Promise<CliResult> & { stdout: Readable; kill: (signal: NodeJS.Signals) => void };

function waitForCliOutput(child: CliProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CLI did not print ${text}:\n${output}`));
    }, 20_000);
    child.stdout.on("data", onData);
    void child.then(
      (result) => {
        cleanup();
        return reject(new Error(`CLI exited before ${text}:\n${result.stderr}`));
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

test("logs --since filters history and live output through the CLI and daemon", async () => {
  const cliHome = await mkdtemp(join(tmpdir(), "paseo-logs-cli-home-"));
  const port = 1; // Invalid dates must fail before trying this unavailable endpoint.
  const runLocalPaseo = (
    args: string[],
    env: NodeJS.ProcessEnv = {},
    cwd = cliHome,
  ): CliProcess => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        ...args,
      ],
      {
        cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
          ),
          ...env,
          HOME: cliHome,
          USERPROFILE: cliHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 25_000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const done = new Promise<CliResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
    return Object.assign(done, {
      stdout: child.stdout,
      kill: (signal: NodeJS.Signals) => {
        child.kill(signal);
      },
    });
  };
  // Follow assertions check output; Windows forcibly terminates Node on SIGINT.
  try {
    console.log("--since filters logs through the real CLI and daemon");
    const historyEvents: AgentStreamEvent[] = [];
    const startedPrompts: AgentPromptInput[] = [];
    const rewindSession = new FakeRewindSession();
    const ctx = await createDaemonTestContext({
      agentClients: {
        ...createTestAgentClients({
          historyEvents,
          onStartTurn: (prompt) => {
            startedPrompts.push(prompt);
          },
        }),
        claude: {
          provider: "claude",
          capabilities: REWIND_TEST_CAPABILITIES,
          createSession: async () => rewindSession,
          resumeSession: async () => rewindSession,
          fetchCatalog: async () => ({ models: [], modes: [] }),
          isAvailable: async () => true,
        },
      },
    });
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd: ctx.daemon.paseoHome,
        title: "logs since",
      });
      const manager = ctx.daemon.daemon.agentManager;
      await manager.appendTimelineItem(agent.id, { type: "user_message", text: "OLD_USER" });
      await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "OLD_REPLY" });
      const host = `127.0.0.1:${ctx.daemon.port}`;
      const logs = (args: string[]) =>
        runLocalPaseo(["--host", host, ...args], {}, ctx.daemon.paseoHome);

      const missing = await logs(["logs", "missing-agent", "--json"]);
      assert.strictEqual(missing.exitCode, 1, missing.stderr);
      assert.strictEqual(JSON.parse(missing.stderr).error.code, "AGENT_NOT_FOUND");
      const baseline = await logs(["logs", agent.id]);
      assert.strictEqual(baseline.exitCode, 0, baseline.stderr);
      assert.strictEqual(baseline.stdout, "[User] OLD_USER\nOLD_REPLY\n");

      const structuredAgent = await ctx.client.createAgent({
        provider: "codex",
        cwd: ctx.daemon.paseoHome,
        title: "structured logs",
      });
      await manager.appendTimelineItem(structuredAgent.id, {
        type: "user_message",
        text: "OLD_USER",
      });
      await manager.appendTimelineItem(structuredAgent.id, {
        type: "assistant_message",
        text: "OLD_REPLY",
      });
      const sourceBefore = await ctx.client.fetchAgentTimeline(structuredAgent.id, { limit: 0 });
      const forked = await logs([
        "agent",
        "fork",
        structuredAgent.id,
        "continue",
        "--no-wait",
        "--json",
        "--relationship",
        "detached",
      ]);
      assert.strictEqual(forked.exitCode, 0, forked.stderr);
      const forkId = JSON.parse(forked.stdout).agentId;
      assert.notStrictEqual(forkId, structuredAgent.id);
      const promptText = JSON.stringify(startedPrompts);
      assert.ok(promptText.includes("OLD_USER"), promptText);
      assert.ok(promptText.includes("OLD_REPLY"), promptText);
      const sourceAfter = await ctx.client.fetchAgentTimeline(structuredAgent.id, { limit: 0 });
      assert.deepStrictEqual(sourceAfter.entries, sourceBefore.entries);
      const forkSnapshot = await ctx.client.fetchAgent({ agentId: forkId });
      assert.strictEqual(forkSnapshot?.agent.provider, "codex");
      const rewindable = await ctx.client.createAgent({
        provider: "claude",
        cwd: ctx.daemon.paseoHome,
      });
      const rewindResult = await logs([
        "agent",
        "rewind",
        rewindable.id,
        "--to",
        "message-1",
        "--mode",
        "conversation",
        "--json",
      ]);
      assert.strictEqual(rewindResult.exitCode, 0, rewindResult.stderr);
      assert.deepStrictEqual(rewindSession.recordedRewinds, [
        { mode: "conversation", messageId: "message-1" },
      ]);
      assert.strictEqual(JSON.parse(rewindResult.stdout).changed, true);
      const unsupportedRewind = await logs([
        "agent",
        "rewind",
        structuredAgent.id,
        "--to",
        "missing",
        "--mode",
        "files",
        "--json",
      ]);
      assert.strictEqual(unsupportedRewind.exitCode, 1, unsupportedRewind.stderr);
      assert.strictEqual(JSON.parse(unsupportedRewind.stderr).error.code, "UNSUPPORTED_FEATURE");

      const nativeParent = await ctx.client.createAgent({
        provider: "codex",
        cwd: ctx.daemon.paseoHome,
        title: "Native parent",
      });
      historyEvents.push(
        {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "upsert",
            id: "native-child",
            title: "Native child",
            status: "completed",
            parentSubagentId: "native-ancestor",
          },
        },
        {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "timeline",
            id: "native-child",
            item: { type: "user_message", text: "CHILD_USER" },
          },
        },
        {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "timeline",
            id: "native-child",
            item: {
              type: "tool_call",
              callId: "child-tool",
              name: "Bash",
              status: "completed",
              detail: {
                type: "unknown",
                input: { nested: true },
                output: "child output ".repeat(100),
              },
              error: null,
            },
          },
        },
      );
      await ctx.client.refreshAgent(nativeParent.id);
      const managedChild = await ctx.client.createAgent({
        provider: "codex",
        cwd: ctx.daemon.paseoHome,
        callerAgentId: nativeParent.id,
        relationship: "subagent",
      });
      const subagents = await logs(["agent", "subagents", nativeParent.id.slice(0, 12), "--json"]);
      assert.strictEqual(subagents.exitCode, 0, subagents.stderr);
      const children = JSON.parse(subagents.stdout);
      assert.deepStrictEqual(
        children.paseoChildren.map((child: { id: string }) => child.id),
        [managedChild.id],
      );
      assert.strictEqual(children.providerSubagents[0].id, "native-child");
      assert.strictEqual(children.providerSubagents[0].parentSubagentId, "native-ancestor");
      const nativePage = await logs([
        "agent",
        "subagents",
        "timeline",
        nativeParent.id,
        "native-child",
        "--json",
        "--limit",
        "1",
      ]);
      assert.strictEqual(nativePage.exitCode, 0, nativePage.stderr);
      const nativeRows = JSON.parse(nativePage.stdout);
      assert.strictEqual(nativeRows.rows.length, 1);
      assert.strictEqual(nativeRows.rows[0].item.detail.output, "child output ".repeat(100));
      const nativeBefore = await logs([
        "agent",
        "subagents",
        "timeline",
        nativeParent.id,
        "native-child",
        "--json",
        "--limit",
        "1",
        "--before",
        `${nativeRows.startCursor.epoch}:${nativeRows.startCursor.seq}`,
      ]);
      assert.strictEqual(nativeBefore.exitCode, 0, nativeBefore.stderr);
      assert.strictEqual(JSON.parse(nativeBefore.stdout).rows[0].item.text, "CHILD_USER");
      historyEvents.length = 0;

      const toolOutput = "complete tool output ".repeat(100);
      await manager.appendTimelineItem(structuredAgent.id, {
        type: "tool_call",
        callId: "lossless",
        name: "Bash",
        status: "completed",
        detail: { type: "unknown", input: { command: "test" }, output: toolOutput },
        error: null,
      });
      const structured = await logs([
        "agent",
        "logs",
        structuredAgent.id,
        "--json",
        "--limit",
        "1",
      ]);
      assert.strictEqual(structured.exitCode, 0, structured.stderr);
      const page = JSON.parse(structured.stdout);
      assert.strictEqual(page.entries.length, 1);
      assert.strictEqual(page.entries[0].item.detail.output, toolOutput);
      assert.strictEqual(typeof page.entries[0].timestamp, "string");
      const before = await logs([
        "logs",
        structuredAgent.id,
        "--json",
        "--limit",
        "1",
        "--before",
        `${page.startCursor.epoch}:${page.startCursor.seq}`,
      ]);
      assert.strictEqual(before.exitCode, 0, before.stderr);
      const older = JSON.parse(before.stdout);
      assert.strictEqual(older.entries.length, 1);
      assert.ok(older.entries[0].seqEnd < page.entries[0].seqStart);
      const full = await logs(["agent", "logs", structuredAgent.id, "--full", "--limit", "1"]);
      assert.strictEqual(full.exitCode, 0, full.stderr);
      assert.strictEqual(JSON.parse(full.stdout).entries[0].item.detail.output, toolOutput);
      const pluginData = { nested: [1, "two", { ok: true }] };
      await manager.appendTimelineItem(structuredAgent.id, {
        type: "plugin",
        id: "plugin-1",
        pluginId: "example",
        kind: "result",
        version: 1,
        data: pluginData,
      });
      const plugin = await logs(["logs", structuredAgent.id, "--json", "--limit", "1"]);
      assert.strictEqual(plugin.exitCode, 0, plugin.stderr);
      assert.deepStrictEqual(JSON.parse(plugin.stdout).entries[0].item.data, pluginData);
      const prompts = await logs(["agent", "prompts", structuredAgent.id, "--json"]);
      assert.strictEqual(prompts.exitCode, 0, prompts.stderr);
      assert.strictEqual(JSON.parse(prompts.stdout).prompts[0].preview, "OLD_USER");
      const search = await logs([
        "agent",
        "logs",
        structuredAgent.id,
        "--search",
        "OLD_USER",
        "--json",
      ]);
      assert.strictEqual(search.exitCode, 0, search.stderr);
      assert.strictEqual(JSON.parse(search.stdout).locations.length, 1);

      for (const command of [["logs"], ["agent", "logs"]]) {
        const result = await logs([...command, agent.id, "--since", "2100-01-01T00:00:00Z"]);
        console.log(`paseo ${command.join(" ")} <id> --since 2100-01-01T00:00:00Z`);
        console.log(`exit=${result.exitCode}\nstdout:\n${result.stdout}stderr:\n${result.stderr}`);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        assert.strictEqual(result.stdout, "No activity to display.\n");
      }

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      const firstTimestamp = timeline.entries[0]?.timestamp;
      assert(firstTimestamp !== undefined, "the fixture should have timestamped activity");
      for (const since of ["2000-01-01T00:00:00Z", firstTimestamp]) {
        const result = await logs(["logs", agent.id, "--since", since]);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        assert.strictEqual(result.stdout, baseline.stdout);
      }

      const offset = await logs(["logs", agent.id, "--since", "2100-01-01T08:00:00+08:00"]);
      assert.strictEqual(offset.exitCode, 0, offset.stderr);
      assert.strictEqual(offset.stdout, "No activity to display.\n");

      const tail = await logs([
        "logs",
        agent.id,
        "--since",
        "2000-01-01T00:00:00Z",
        "--filter",
        "text",
        "--tail",
        "1",
      ]);
      assert.strictEqual(tail.exitCode, 0, tail.stderr);
      assert.strictEqual(tail.stdout, "OLD_REPLY\n");

      const empty = await logs(["logs", agent.id, "--since", firstTimestamp, "--tail", "0"]);
      assert.strictEqual(empty.exitCode, 0, empty.stderr);
      assert.strictEqual(empty.stdout, "");

      for (const followArgs of [[], ["--follow"]]) {
        const invalid = await runLocalPaseo([
          "--host",
          `127.0.0.1:${port}`,
          "logs",
          "missing-agent",
          "--since",
          "not-a-date",
          "--json",
          ...followArgs,
        ]);
        assert.strictEqual(invalid.exitCode, 1, invalid.stderr);
        assert.strictEqual(invalid.stdout, "");
        assert.deepStrictEqual(JSON.parse(invalid.stderr), {
          error: {
            code: "INVALID_TIMESTAMP",
            message: "Invalid --since value: not-a-date",
            details: "Use a timestamp such as 2026-01-01T00:00:00Z.",
          },
        });
      }

      console.log("--since filters initial history in follow mode");
      const follow = logs(["logs", agent.id, "--follow", "--since", "2100-01-01T00:00:00Z"]);
      try {
        await waitForCliOutput(follow, "--- Following logs");
      } finally {
        await follow.kill("SIGINT");
      }
      const followed = await follow;
      console.log(`follow exit=${followed.exitCode}\nstdout:\n${followed.stdout}`);
      assert.strictEqual(followed.stdout.includes("OLD_USER"), false);
      assert.strictEqual(followed.stdout.includes("OLD_REPLY"), false);

      console.log("--since filters live events in follow mode");
      const futureFollow = logs([
        "agent",
        "logs",
        agent.id,
        "-f",
        "--tail",
        "0",
        "--since",
        "2100-01-01T00:00:00Z",
      ]);
      try {
        await waitForCliOutput(futureFollow, "--- Following logs");
        // A timestamped history replay follows the live item on the same socket.
        // Its visible output proves the CLI consumed the earlier item too.
        await Promise.all([
          waitForCliOutput(futureFollow, "AFTER_CUTOFF"),
          (async () => {
            await manager.appendTimelineItem(agent.id, {
              type: "user_message",
              text: "LIVE_BEFORE_CUTOFF",
            });
            historyEvents.push({
              type: "timeline",
              provider: "codex",
              timestamp: "2110-01-01T00:00:00Z",
              item: { type: "user_message", text: "AFTER_CUTOFF" },
            });
            await ctx.client.refreshAgent(agent.id);
          })(),
        ]);
      } finally {
        await futureFollow.kill("SIGINT");
      }
      const futureOutput = await futureFollow;
      console.log(`future follow exit=${futureOutput.exitCode}\nstdout:\n${futureOutput.stdout}`);
      assert.strictEqual(futureOutput.stdout.includes("LIVE_BEFORE_CUTOFF"), false);

      console.log("follow still prints live events after --since");
      const pastFollow = logs([
        "logs",
        agent.id,
        "--follow",
        "--tail",
        "0",
        "--filter",
        "text",
        "--since",
        "2000-01-01T00:00:00Z",
      ]);
      try {
        await waitForCliOutput(pastFollow, "--- Following logs");
        await Promise.all([
          // Wait for a later visible item to close the streamed reply.
          // Windows SIGINT forcibly exits without running shutdown handlers.
          waitForCliOutput(pastFollow, "[User] LIVE_AFTER_REPLY\n"),
          (async () => {
            await manager.appendTimelineItem(agent.id, { type: "user_message", text: "LIVE_USER" });
            await manager.appendTimelineItem(agent.id, {
              type: "assistant_message",
              text: "LIVE_REPLY",
            });
            await manager.appendTimelineItem(agent.id, {
              type: "user_message",
              text: "LIVE_AFTER_REPLY",
            });
          })(),
        ]);
      } finally {
        await pastFollow.kill("SIGINT");
      }
      const pastOutput = await pastFollow;
      console.log(`past follow exit=${pastOutput.exitCode}\nstdout:\n${pastOutput.stdout}`);
      assert(pastOutput.stdout.includes("[User] LIVE_USER\nLIVE_REPLY\n"), pastOutput.stdout);
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await rm(cliHome, { recursive: true, force: true });
  }
}, 120_000);
