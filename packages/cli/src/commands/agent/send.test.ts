import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";
import { addSendOptions, runSendCommand } from "./send.js";
import { resolvePromptInput } from "../../utils/prompt-input.js";

const daemonTarget = { kind: "endpoint" as const, host: "daemon.test:12345" };

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));
vi.mock("../../utils/caller-agent.js", () => ({ resolveCallerAgentId: vi.fn(async () => null) }));

function createClient(resolvedAgentId = "agent-1") {
  const client = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "cli-send-test",
    reconnect: { enabled: false },
  });
  const sendAgentMessage = vi
    .spyOn(client, "sendAgentMessage")
    .mockResolvedValue({ agentId: resolvedAgentId });
  const waitForFinish = vi.spyOn(client, "waitForFinish").mockResolvedValue({
    status: "idle",
    final: null,
    error: null,
    lastMessage: null,
  });
  vi.spyOn(client, "close").mockResolvedValue();
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client);
  return { client, sendAgentMessage, waitForFinish };
}

function parseSend(args: string[]) {
  const command = addSendOptions(
    new Command("send").exitOverride().configureOutput({
      writeErr: () => {},
    }),
  );
  command.action(() => {});
  command.parse(args, { from: "user" });
  return command.opts();
}

describe("agent send --if-running", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("steers a running agent unless told otherwise, and only accepts known behaviors", () => {
    expect(parseSend(["agent-1", "hello"]).ifRunning).toBe("steer");
    expect(parseSend(["agent-1", "hello", "--if-running", "interrupt"]).ifRunning).toBe(
      "interrupt",
    );
    expect(parseSend(["agent-1", "hello", "--if-running", "queue"]).ifRunning).toBe("queue");
    expect(() => parseSend(["agent-1", "hello", "--if-running", "later"])).toThrow();
  });

  it("waits for the message it sent, so a held message is not reported early", async () => {
    const { sendAgentMessage, waitForFinish } = createClient();

    await runSendCommand("agent-1", "hello", { daemonTarget, ifRunning: "steer" }, new Command());

    const sent = sendAgentMessage.mock.calls[0]![2]!;
    expect(sent).toMatchObject({ activeTurnBehavior: "steer", messageId: expect.any(String) });
    expect(waitForFinish).toHaveBeenCalledWith("agent-1", 600000, { messageId: sent.messageId });
  });

  it("waits on and reports the Paseo ID the daemon resolved a session ID to", async () => {
    const { sendAgentMessage, waitForFinish } = createClient("agent-1");

    const waited = await runSendCommand("thread-abc", "hello", { daemonTarget }, new Command());
    const queued = createClient("agent-1");
    const noWait = await runSendCommand(
      "thread-abc",
      "hello",
      { daemonTarget, wait: false },
      new Command(),
    );

    expect(sendAgentMessage.mock.calls[0]![0]).toBe("thread-abc");
    expect(waitForFinish.mock.calls[0]![0]).toBe("agent-1");
    expect(waited.data.agentId).toBe("agent-1");
    expect(queued.waitForFinish).not.toHaveBeenCalled();
    expect(noWait.data.agentId).toBe("agent-1");
  });
});

describe("run and send prompt input", () => {
  const noSources = { promptArgument: undefined, promptOption: undefined, promptFile: undefined };

  it("preserves inline text and only reads stdin when explicitly selected", async () => {
    const unreadStdin = {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        throw new Error("stdin was read without --prompt-file -");
      },
    };
    for (const source of ["promptArgument", "promptOption"] as const) {
      await expect(
        resolvePromptInput({ ...noSources, [source]: "  task\n" }, unreadStdin),
      ).resolves.toBe("  task\n");
    }
    await expect(resolvePromptInput(noSources, unreadStdin)).rejects.toMatchObject({
      code: "MISSING_PROMPT",
    });
  });

  it("reads UTF-8 files unchanged and rejects blank or unreadable files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-prompt-test-"));
    const filename = join(directory, "prompt.txt");
    try {
      await writeFile(filename, "  café\nsecond line\n");
      await expect(resolvePromptInput({ ...noSources, promptFile: filename })).resolves.toBe(
        "  café\nsecond line\n",
      );
      await writeFile(filename, " \n\t");
      await expect(
        resolvePromptInput({ ...noSources, promptFile: filename }),
      ).rejects.toMatchObject({ code: "MISSING_PROMPT" });
      await expect(
        resolvePromptInput({ ...noSources, promptFile: join(directory, "missing.txt") }),
      ).rejects.toMatchObject({ code: "PROMPT_FILE_READ_ERROR" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("decodes stdin across UTF-8 chunk boundaries and rejects empty stdin", async () => {
    const bytes = Buffer.from("  café\n");
    await expect(
      resolvePromptInput(
        { ...noSources, promptFile: "-" },
        Readable.from([bytes.subarray(0, 6), bytes.subarray(6)]),
      ),
    ).resolves.toBe("  café\n");
    await expect(
      resolvePromptInput({ ...noSources, promptFile: "-" }, Readable.from([" \n"])),
    ).rejects.toMatchObject({ code: "MISSING_PROMPT" });
  });

  it.each([
    { promptArgument: "task", promptOption: "other" },
    { promptArgument: "task", promptFile: "-" },
    { promptOption: "task", promptFile: "-" },
    { promptArgument: "", promptFile: "-" },
  ])("rejects conflicting explicit prompt sources: %j", async (sources) => {
    await expect(resolvePromptInput({ ...noSources, ...sources })).rejects.toMatchObject({
      code: "CONFLICTING_PROMPT_INPUT",
    });
  });
});

import {
  collectAttachment,
  prepareAttachments,
  resolveAttachments,
} from "../../utils/agent-attachments.js";

describe("structured attachments", () => {
  it("preserves literal punctuation and rejects unknown/empty kinds before dispatch", async () => {
    expect(collectAttachment("text:a,b:c", ["text:first"])).toEqual(["text:first", "text:a,b:c"]);
    expect(await prepareAttachments(["text:a,b:c"])).toEqual([{ kind: "text", text: "a,b:c" }]);
    await expect(prepareAttachments(["wat:value"])).rejects.toThrow("Unknown attachment kind");
    await expect(prepareAttachments(["file:"])).rejects.toThrow("Use --attach");
    await expect(
      prepareAttachments(["github-issue:https://github.com/a/b/pull/1"]),
    ).rejects.toThrow("Invalid");
  });

  it("uploads local bytes and retains text and canonical forge metadata in order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-attachment-"));
    try {
      const filePath = join(directory, "notes,a.txt");
      await writeFile(filePath, "hello");
      const uploaded = {
        type: "uploaded_file" as const,
        id: "f",
        fileName: "notes,a.txt",
        mimeType: "text/plain",
        size: 5,
        path: "/uploads/f",
      };
      const requests: unknown[] = [];
      const result = await resolveAttachments(
        {
          uploadFile: async (input) => {
            requests.push(input);
            return { requestId: "u", file: uploaded, error: null };
          },
          searchForge: async (input) => {
            requests.push(input);
            return {
              requestId: "s",
              error: null,
              authState: "authenticated",
              items: [
                {
                  kind: "issue",
                  number: 1,
                  title: "Issue",
                  url: "https://github.com/a/b/issues/1",
                  state: "open",
                  body: "Context",
                  labels: [],
                },
              ],
            };
          },
          getLastServerInfoMessage: () =>
            ({ features: { forgeSearch: true } }) as ReturnType<
              DaemonClient["getLastServerInfoMessage"]
            >,
        },
        await prepareAttachments([
          "text:a,b",
          `file:${filePath}`,
          "github-issue:https://github.com/a/b/issues/1",
        ]),
        "/target",
      );
      expect(result).toEqual([
        { type: "text", mimeType: "text/plain", text: "a,b" },
        uploaded,
        {
          type: "forge_issue",
          mimeType: "application/paseo-forge-issue",
          forge: "github",
          number: 1,
          title: "Issue",
          url: "https://github.com/a/b/issues/1",
          body: "Context",
          projectPath: undefined,
        },
      ]);
      expect(requests).toEqual([
        {
          kind: "file",
          fileName: "notes,a.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("hello"),
        },
        { cwd: "/target", query: "https://github.com/a/b/issues/1", kinds: ["issue"], limit: 50 },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("refuses ambiguous or wrong forge matches and propagates upload errors", async () => {
  const item = {
    kind: "issue" as const,
    number: 1,
    title: "Issue",
    url: "https://github.com/a/b/issues/1",
    state: "open",
    body: null,
    labels: [],
  };
  let items = [item, item];
  const client = {
    uploadFile: async () => ({ requestId: "u", file: null, error: "disk full" }),
    searchForge: async () => ({ requestId: "s", error: null, items, authState: "authenticated" }),
    getLastServerInfoMessage: () =>
      ({ features: { forgeSearch: true } }) as ReturnType<DaemonClient["getLastServerInfoMessage"]>,
  };
  const prepared = await prepareAttachments(["github-issue:https://github.com/a/b/issues/1"]);
  await expect(resolveAttachments(client, prepared, "/target")).rejects.toThrow("exactly one");
  items = [{ ...item, url: "https://github.com/other/repo/issues/1" }];
  await expect(resolveAttachments(client, prepared, "/target")).rejects.toThrow("exactly one");
  await expect(
    resolveAttachments(
      client,
      [{ kind: "file", fileName: "a", bytes: new Uint8Array(), mimeType: "text/plain" }],
      "/target",
    ),
  ).rejects.toThrow("disk full");
  await expect(prepareAttachments(["file:/nonexistent/cli-attachment-file"])).rejects.toThrow();
});

it("forwards text attachments and raw slash command arguments through send", async () => {
  const { sendAgentMessage } = createClient();
  await runSendCommand(
    "agent-1",
    "/cmd args",
    { daemonTarget, wait: false, attach: ["text:context,args"] },
    new Command(),
  );
  expect(sendAgentMessage.mock.calls[0]![1]).toBe("/cmd args");
  expect(sendAgentMessage.mock.calls[0]![2]!.attachments).toEqual([
    { type: "text", mimeType: "text/plain", text: "context,args" },
  ]);
});

it("hydrates PRs in the resolved send target and refuses failed uploads before dispatch", async () => {
  const context = createClient();
  const target = vi
    .spyOn(context.client, "fetchAgent")
    .mockResolvedValue({ agent: { id: "agent-1", cwd: "/remote/repo" } } as Awaited<
      ReturnType<DaemonClient["fetchAgent"]>
    >);
  vi.spyOn(context.client, "getLastServerInfoMessage").mockReturnValue({
    status: "server_info",
    serverId: "host",
    features: { forgeSearch: true },
  });
  const search = vi.spyOn(context.client, "searchForge").mockResolvedValue({
    requestId: "s",
    error: null,
    items: [
      {
        kind: "change_request",
        number: 7,
        title: "Merged",
        url: "https://github.com/a/b/pull/7",
        state: "MERGED",
        body: "details",
        labels: [],
        baseRefName: "dev",
        headRefName: "feature",
      },
    ],
  });
  const close = vi.mocked(context.client.close);
  await runSendCommand(
    "agent-prefix",
    "review",
    { daemonTarget, wait: false, attach: ["github-pr:https://github.com/a/b/pull/7"] },
    new Command(),
  );
  expect(target).toHaveBeenCalledWith({ agentId: "agent-prefix" });
  expect(search).toHaveBeenCalledWith({
    cwd: "/remote/repo",
    query: "https://github.com/a/b/pull/7",
    kinds: ["change_request"],
    limit: 50,
  });
  expect(context.sendAgentMessage.mock.calls[0]![2]!.attachments).toEqual([
    {
      type: "forge_change_request",
      forge: "github",
      mimeType: "application/paseo-forge-change-request",
      number: 7,
      title: "Merged",
      url: "https://github.com/a/b/pull/7",
      body: "details",
      baseRefName: "dev",
      headRefName: "feature",
    },
  ]);
  expect(close).toHaveBeenCalledTimes(1);
  const directory = await mkdtemp(join(tmpdir(), "cli-send-upload-"));
  try {
    const file = join(directory, "notes.txt");
    await writeFile(file, "hello");
    const failed = createClient();
    vi.spyOn(failed.client, "fetchAgent").mockResolvedValue({
      agent: { id: "agent-1", cwd: "/remote/repo" },
    } as Awaited<ReturnType<DaemonClient["fetchAgent"]>>);
    vi.spyOn(failed.client, "uploadFile").mockResolvedValue({
      requestId: "u",
      error: "disk full",
      file: null,
    });
    await expect(
      runSendCommand(
        "agent-1",
        "read",
        { daemonTarget, wait: false, attach: [`file:${file}`] },
        new Command(),
      ),
    ).rejects.toMatchObject({ message: "Failed to send message: disk full" });
    expect(failed.sendAgentMessage).not.toHaveBeenCalled();
    expect(failed.client.close).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
