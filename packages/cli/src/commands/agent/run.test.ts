import { prepareAgentFork } from "./fork.js";
import { runRewindCommand } from "./rewind.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import {
  addRunOptions,
  resolveExistingRunWorkspace,
  runRunCommand,
  waitsForFinish,
  type AgentRunOptions,
} from "./run";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

function createAgentSnapshot(id: string) {
  return AgentSnapshotPayloadSchema.parse({
    id,
    provider: "codex",
    cwd: "/workspace",
    model: "gpt-5.4",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Task",
    labels: {},
  });
}

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId } };
    },
  };
}

describe("run wait policy", () => {
  it("waits by default and stops waiting on --no-wait or a legacy alias", () => {
    expect(waitsForFinish({})).toBe(true);
    expect(waitsForFinish({ wait: false })).toBe(false);
    expect(waitsForFinish({ background: true })).toBe(false);
    expect(waitsForFinish({ detach: true })).toBe(false);
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, new Command("run")),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        new Command("run"),
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });

  it("accepts prompt flags without a positional prompt and requires an explicit provider", async () => {
    const command = addRunOptions(new Command("run").exitOverride());
    command.action(() => {});
    command.parse(["--prompt", "do something"], { from: "user" });
    expect(command.opts().prompt).toBe("do something");
    await expect(
      runRunCommand(undefined, { ...command.opts(), daemonTarget }, command),
    ).rejects.toMatchObject({ code: "MISSING_PROVIDER" });
    const fileCommand = addRunOptions(new Command("run").exitOverride());
    fileCommand.action(() => {});
    fileCommand.parse(["--prompt-file", "-", "--provider", "codex"], { from: "user" });
    expect(fileCommand.opts()).toMatchObject({ promptFile: "-", provider: "codex" });
  });

  it.each([
    {
      prompt: undefined,
      options: {},
      code: "MISSING_PROMPT",
    },
    {
      prompt: "task",
      options: { promptFile: "-" },
      code: "CONFLICTING_PROMPT_INPUT",
    },
    {
      prompt: undefined,
      options: { promptFile: "/nonexistent/paseo-prompt.txt" },
      code: "PROMPT_FILE_READ_ERROR",
    },
    {
      prompt: "task",
      options: { waitTimeout: "7days" },
      code: "INVALID_TIMEOUT",
    },
  ])("rejects $code before connecting", async ({ prompt, options, code }) => {
    await expect(
      runRunCommand(prompt, { ...options, provider: "codex", daemonTarget }, new Command()),
    ).rejects.toMatchObject({ code });
  });
});

describe("run feature values", () => {
  it("passes parsed provider feature values to agent creation", async () => {
    const originalCallerId = process.env.PASEO_AGENT_ID;
    const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "cli-run-feature-test",
      reconnect: { enabled: false },
    });
    const parentAgent = createAgentSnapshot("parent-agent");
    const createdAgent = createAgentSnapshot("created-agent");
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue({
      status: "server_info",
      serverId: "cli-run-feature-test",
      features: { agentOrchestrationParity: true },
    });
    vi.spyOn(client, "fetchAgent").mockResolvedValue({ agent: parentAgent, project: null });
    const createAgent = vi.spyOn(client, "createAgent").mockResolvedValue(createdAgent);
    vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
    process.env.PASEO_AGENT_ID = parentAgent.id;
    delete process.env.PASEO_WORKSPACE_ID;

    try {
      await expect(
        runRunCommand(
          "do something",
          {
            provider: "codex/gpt-5.4",
            feature: ["fast_mode=true", "service_tier=flex"],
            attach: ["text:standard,context"],
            wait: false,
            daemonTarget,
          },
          new Command("run"),
        ),
      ).resolves.toMatchObject({ data: { agentId: "created-agent" } });
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          featureValues: { fast_mode: true, service_tier: "flex" },
          attachments: [{ type: "text", mimeType: "text/plain", text: "standard,context" }],
        }),
      );
    } finally {
      if (originalCallerId === undefined) delete process.env.PASEO_AGENT_ID;
      else process.env.PASEO_AGENT_ID = originalCallerId;
      if (originalWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
      else process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });
});

describe("structured run output", () => {
  beforeEach(() => {
    vi.stubEnv("PASEO_AGENT_ID", "parent-agent");
    vi.stubEnv("PASEO_WORKSPACE_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function fixture(response: string, fork = false, attach: string[] = []) {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "cli-structured-run-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue({
      status: "server_info",
      serverId: "cli-structured-run-test",
      features: { agentOrchestrationParity: true, agentForkContext: true },
    });
    vi.spyOn(client, "fetchAgent").mockResolvedValue({
      agent: createAgentSnapshot("parent-agent"),
      project: null,
    });
    vi.spyOn(client, "buildAgentForkContext").mockResolvedValue({
      agentId: "parent-agent",
      requestId: "test",
      boundaryMessageId: null,
      boundaryCursor: null,
      itemCount: 1,
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "History",
        text: "prior history",
      },
      error: null,
    });
    const createAgent = vi
      .spyOn(client, "createAgent")
      .mockResolvedValue(createAgentSnapshot("structured-agent"));
    const waitForFinish = vi.spyOn(client, "waitForFinish").mockResolvedValue({
      status: "idle",
      final: createAgentSnapshot("structured-agent"),
      error: null,
      lastMessage: response,
    });
    const sendMessage = vi.spyOn(client, "sendMessage").mockResolvedValue();
    const close = vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
    const run = () =>
      runRunCommand(
        "Answer the question",
        {
          provider: "codex",
          attach,
          forkSource: fork ? { agentId: "parent-agent" } : undefined,
          daemonTarget,
          outputSchema: JSON.stringify({
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          }),
        },
        new Command("run"),
      );
    return { run, createAgent, waitForFinish, sendMessage, close };
  }

  it("loads the real schema validator and serializes a valid response", async () => {
    const context = fixture('{"answer":"ready"}');
    const result = await context.run();
    expect(result.data).toMatchObject({ agentId: "structured-agent", status: "completed" });
    expect(result.schema.serialize!(result.data)).toEqual({ answer: "ready" });
    expect(context.createAgent).toHaveBeenCalledTimes(1);
    expect(context.waitForFinish).toHaveBeenCalledTimes(1);
    expect(context.sendMessage).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("forwards fork history through structured agent creation", async () => {
    const context = fixture('{"answer":"ready"}', true, ["text:extra,context"]);
    await context.run();
    expect(context.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ contextKind: "chat_history", text: "prior history" }),
          { type: "text", mimeType: "text/plain", text: "extra,context" },
        ],
      }),
    );
  });

  it("exhausts schema retries and renders the lazy validator's failure", async () => {
    const context = fixture('{"answer":42}');
    await expect(context.run()).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_FAILED",
      message: "Agent response did not match the required output schema",
      details: expect.stringContaining("must be string"),
    });
    expect(context.createAgent).toHaveBeenCalledTimes(1);
    expect(context.waitForFinish).toHaveBeenCalledTimes(3);
    expect(context.sendMessage).toHaveBeenCalledTimes(2);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

describe("mode check before workspace creation", () => {
  const modes = {
    entries: [
      {
        provider: "codex",
        modes: [
          { id: "auto", label: "Default Permissions" },
          { id: "full-access", label: "Full Access" },
        ],
      },
    ],
  };

  function setup(callerAgentId?: string) {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "cli-run-mode-test",
      reconnect: { enabled: false },
    });
    vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue({
      status: "server_info",
      serverId: "cli-run-mode-test",
      features: { agentOrchestrationParity: true },
    });
    if (callerAgentId) {
      vi.spyOn(client, "fetchAgent").mockResolvedValue({
        agent: createAgentSnapshot(callerAgentId),
        project: null,
      });
    }
    const getProvidersSnapshot = vi
      .spyOn(client, "getProvidersSnapshot")
      .mockResolvedValue(modes as never);
    const createWorkspace = vi.spyOn(client, "createWorkspace").mockResolvedValue({
      workspace: { id: "ws-new", name: "new", workspaceDirectory: "/workspace", projectId: "prj" },
    } as never);
    const fetchWorkspaces = vi.spyOn(client, "fetchWorkspaces").mockResolvedValue({
      entries: [{ id: "ws-existing", workspaceDirectory: "/workspace/existing" }],
      pageInfo: { nextCursor: null },
    } as never);
    vi.spyOn(client, "createAgent").mockResolvedValue(createAgentSnapshot("created-agent"));
    vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
    return { getProvidersSnapshot, createWorkspace, fetchWorkspaces };
  }

  beforeEach(() => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    vi.stubEnv("PASEO_WORKSPACE_ID", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const run = (options: Partial<AgentRunOptions>) =>
    runRunCommand(
      "do something",
      { provider: "codex", wait: false, daemonTarget, ...options },
      new Command("run"),
    );

  it("rejects a mode label before creating a workspace", async () => {
    const { createWorkspace } = setup();
    await expect(run({ newWorkspace: "local", mode: "Full Access" })).rejects.toMatchObject({
      code: "INVALID_MODE",
      message: expect.stringContaining("use the mode id 'full-access'"),
    });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("creates the workspace for a valid mode id, and when the snapshot fails", async () => {
    const valid = setup();
    await expect(run({ newWorkspace: "local", mode: "full-access" })).resolves.toMatchObject({
      data: { agentId: "created-agent" },
    });
    expect(valid.createWorkspace).toHaveBeenCalledOnce();

    const offline = setup();
    offline.getProvidersSnapshot.mockRejectedValue(new Error("offline"));
    await expect(run({ newWorkspace: "local", mode: "turbo" })).resolves.toMatchObject({
      data: { agentId: "created-agent" },
    });
    expect(offline.createWorkspace).toHaveBeenCalledOnce();
  });

  it("skips the check when the run reuses a workspace", async () => {
    const explicit = setup();
    await expect(run({ workspace: "ws-existing", mode: "turbo" })).resolves.toMatchObject({
      data: { agentId: "created-agent" },
    });
    expect(explicit.getProvidersSnapshot).not.toHaveBeenCalled();

    vi.stubEnv("PASEO_AGENT_ID", "parent-agent");
    const caller = setup("parent-agent");
    await expect(run({ mode: "turbo" })).resolves.toMatchObject({
      data: { agentId: "created-agent" },
    });
    expect(caller.getProvidersSnapshot).not.toHaveBeenCalled();
  });
});

describe("agent history commands", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([{}, { provider: "claude" }, { provider: "codex/explicit" }, { workspace: "selected" }])(
    "inherits fork settings without overriding explicit choices %j",
    async (overrides) => {
      const client = new DaemonClient({
        url: "ws://daemon.test",
        clientId: "fork-test",
        reconnect: { enabled: false },
      });
      const agent = createAgentSnapshot("source");
      agent.features = [{ type: "toggle", id: "fast", label: "Fast", value: true }];
      vi.spyOn(client, "getLastServerInfoMessage").mockReturnValue({
        status: "server_info",
        serverId: "test",
        features: { agentForkContext: true },
      });
      vi.spyOn(client, "fetchAgent").mockResolvedValue({ agent, project: null });
      const attachment = {
        type: "text" as const,
        mimeType: "text/plain",
        text: "history",
        contextKind: "chat_history" as const,
        title: "Chat history",
      };
      const context = vi.spyOn(client, "buildAgentForkContext").mockResolvedValue({
        agentId: "source",
        requestId: "test",
        boundaryMessageId: "message",
        boundaryCursor: null,
        itemCount: 1,
        attachment,
        error: null,
      });
      const options: AgentRunOptions = {
        daemonTarget,
        feature: [],
        forkSource: { agentId: "source", boundaryMessageId: "message" },
        ...overrides,
      };
      expect(await prepareAgentFork(client, options)).toEqual([attachment]);
      expect(context).toHaveBeenCalledWith("source", { boundaryMessageId: "message" });
      expect(options.provider).toBe(overrides.provider === "claude" ? "claude" : "codex");
      let expectedModel: string | undefined = "gpt-5.4";
      if (overrides.provider === "claude") expectedModel = undefined;
      if (overrides.provider === "codex/explicit") expectedModel = "explicit";
      expect(options.model).toBe(expectedModel);
      if (options.provider === "codex")
        expect(JSON.parse(options.featuresJson!)).toEqual({ fast: true });
      expect(options.cwd).toBe(overrides.workspace ? undefined : "/workspace");
    },
  );
  it("checks the selected rewind mode and reports the mutation", async () => {
    const client = new DaemonClient({
      url: "ws://daemon.test",
      clientId: "rewind-test",
      reconnect: { enabled: false },
    });
    const agent = createAgentSnapshot("source");
    agent.capabilities.supportsRewindConversation = true;
    vi.spyOn(client, "fetchAgent").mockResolvedValue({ agent, project: null });
    const rewind = vi
      .spyOn(client, "rewindAgent")
      .mockResolvedValue({ ok: true, agentId: "source", requestId: "test" });
    const close = vi.spyOn(client, "close").mockResolvedValue();
    vi.mocked(connectToDaemon).mockResolvedValue(client);
    await expect(
      runRewindCommand("source", {
        daemonTarget,
        to: "message",
        mode: "conversation",
      }),
    ).resolves.toMatchObject({
      data: { agentId: "source", messageId: "message", mode: "conversation", changed: true },
    });
    expect(rewind).toHaveBeenCalledWith("source", "message", "conversation");
    await expect(
      runRewindCommand("source", { daemonTarget, to: "message", mode: "files" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

it.each(["", "  "])(
  "rejects blank fork boundary %j before connection",
  async (boundaryMessageId) => {
    await expect(
      runRunCommand(
        "continue",
        { daemonTarget, forkSource: { agentId: "source", boundaryMessageId } },
        new Command("fork"),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  },
);

it("rejects missing and oversized local attachments before connecting or creating a workspace", async () => {
  const { mkdtemp, truncate, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "cli-run-attachment-"));
  try {
    const oversized = join(directory, "large.txt");
    await writeFile(oversized, "");
    await truncate(oversized, 50 * 1024 * 1024 + 1);
    vi.mocked(connectToDaemon).mockClear();
    for (const file of [join(directory, "missing.txt"), oversized]) {
      await expect(
        runRunCommand("read", { provider: "codex", attach: [`file:${file}`] }, new Command()),
      ).rejects.toThrow();
      expect(connectToDaemon).not.toHaveBeenCalled();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
