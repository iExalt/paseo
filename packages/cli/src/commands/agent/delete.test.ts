import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

import { runArchiveCommand } from "./archive.js";
import { runDeleteCommand } from "./delete.js";
import { render } from "../../output/index.js";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  archivedAt: null as string | null,
  cwd: "/tmp/project",
};
const archivedAgent = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "closed",
  archivedAt: "2026-10-01T00:00:00.000Z",
  cwd: "/tmp/project/nested",
};
const archivedOutsideAgent = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "closed",
  archivedAt: "2026-10-01T00:00:00.000Z",
  cwd: "/tmp/elsewhere",
};
let daemonAgents: (typeof agent)[] = [agent];
const toEntry = (entry: typeof agent) => ({ agent: entry });
// The fake daemon pages history two agents at a time.
const historyPage = (cursor: string | undefined) => {
  const start = Number(cursor ?? 0);
  const end = start + 2;
  return {
    entries: daemonAgents.slice(start, end).map(toEntry),
    pageInfo: { nextCursor: end < daemonAgents.length ? String(end) : null },
  };
};
const cancelAgent = vi.fn(async () => {
  throw new Error("active run cancellation was not acknowledged");
});
const fetchAgentHistory = vi.fn(async (options: { page: { cursor?: string } }) =>
  historyPage(options.page.cursor),
);
const archiveAgent = vi.fn(async () => ({ archivedAt: "2026-11-14T00:00:00.000Z" }));
const deleteAgent = vi.fn(async (_id: string) => undefined);
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    fetchAgents: vi.fn(async () => historyPage(undefined)),
    fetchAgentHistory,
    fetchAgent: vi.fn(async () => ({ agent })),
    cancelAgent,
    deleteAgent,
    archiveAgent,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("runDeleteCommand", () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
  });
  beforeEach(() => {
    daemonAgents = [agent];
    process.exitCode = undefined;
    deleteAgent.mockReset().mockResolvedValue(undefined);
    cancelAgent.mockClear();
    close.mockClear();
    fetchAgentHistory.mockClear();
  });

  it("force-deletes a running agent when graceful cancellation is refused", async () => {
    const result = await runDeleteCommand(agent.id, { daemonTarget }, {} as never);

    expect(fetchAgentHistory).not.toHaveBeenCalled();
    expect(cancelAgent).toHaveBeenCalledWith(agent.id);
    expect(deleteAgent).toHaveBeenCalledWith(agent.id);
    expect(result.data).toEqual({
      deletedCount: 1,
      agentIds: [agent.id],
    });
  });

  it("deletes archived agents on every history page with --all", async () => {
    daemonAgents = [agent, archivedAgent, archivedOutsideAgent];

    const result = await runDeleteCommand(undefined, { daemonTarget, all: true }, {} as never);

    expect(result.data).toEqual({
      deletedCount: 3,
      agentIds: [agent.id, archivedAgent.id, archivedOutsideAgent.id],
      results: [agent, archivedAgent, archivedOutsideAgent].map(({ id }) => ({
        agentId: id,
        deleted: true,
      })),
    });
  });

  it("deletes archived agents inside the directory with --cwd", async () => {
    daemonAgents = [agent, archivedAgent, archivedOutsideAgent];

    const result = await runDeleteCommand(
      undefined,
      { daemonTarget, cwd: "/tmp/project" },
      {} as never,
    );

    expect(result.data).toEqual({
      deletedCount: 2,
      agentIds: [agent.id, archivedAgent.id],
      results: [agent, archivedAgent].map(({ id }) => ({ agentId: id, deleted: true })),
    });
  });
  it.each([
    Object.assign(new Error("refused"), { code: "REFUSED" }),
    { code: "REFUSED", message: "refused" },
  ])("collects coded failures without losing successful deletions: %s", async (error) => {
    daemonAgents = [agent, archivedAgent, archivedOutsideAgent];
    deleteAgent.mockImplementation(async (id) => {
      if (id === archivedAgent.id) {
        throw error;
      }
    });

    const result = await runDeleteCommand(undefined, { daemonTarget, all: true }, {} as never);

    expect(result.data).toEqual({
      deletedCount: 2,
      agentIds: [agent.id, archivedOutsideAgent.id],
      results: [
        { agentId: agent.id, deleted: true },
        { agentId: archivedAgent.id, error: "refused" },
        { agentId: archivedOutsideAgent.id, deleted: true },
      ],
    });
    expect(JSON.parse(render(result, { format: "json" }))).toEqual(result.data);
    expect(render(result, { noColor: true })).toContain(
      "Failed to delete agent " + archivedAgent.id + ": refused",
    );
    expect([...deleteAgent.mock.calls].sort()).toEqual([
      [agent.id],
      [archivedAgent.id],
      [archivedOutsideAgent.id],
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("reports every target when all deletions fail", async () => {
    daemonAgents = [agent, archivedAgent];
    deleteAgent.mockRejectedValue(new Error("offline"));
    const result = await runDeleteCommand(undefined, { daemonTarget, all: true }, {} as never);

    expect(result.data).toEqual({
      deletedCount: 0,
      agentIds: [],
      results: [agent, archivedAgent].map(({ id }) => ({ agentId: id, error: "offline" })),
    });
    expect(deleteAgent).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  it("succeeds without mutations for an empty bulk selection", async () => {
    daemonAgents = [];
    const result = await runDeleteCommand(undefined, { daemonTarget, all: true }, {} as never);

    expect(result.data).toEqual({ deletedCount: 0, agentIds: [], results: [] });
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves single-target coded failures", async () => {
    const error = Object.assign(new Error("refused"), { code: "REFUSED" });
    deleteAgent.mockRejectedValue(error);

    await expect(runDeleteCommand(agent.id, { daemonTarget }, {} as never)).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });
});

it("archives a running agent directly and treats an archived agent as a no-op", async () => {
  const result = await runArchiveCommand(agent.id, { daemonTarget }, {} as never);
  expect(archiveAgent).toHaveBeenCalledExactlyOnceWith(agent.id);
  const timestamp = result.data.archivedAt;
  agent.archivedAt = timestamp;
  try {
    expect((await runArchiveCommand(agent.id, { daemonTarget }, {} as never)).data.archivedAt).toBe(
      timestamp,
    );
    expect(archiveAgent).toHaveBeenCalledTimes(1);
  } finally {
    agent.archivedAt = null;
  }
});
