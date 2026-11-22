import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { LocalAgentDocument, LocalAgentRunDocument, LocalAgentStore } from "@cursor/sdk";
import type {
  ImportableProviderSession,
  ImportProviderSessionInput,
  ListImportableSessionsOptions,
} from "../agent-sdk-types.js";

const localAgentId = /^agent-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function canImport(agent: LocalAgentDocument): boolean {
  const metadata = agent.sdkMetadata;
  return (
    localAgentId.test(agent.agentId) &&
    isAbsolute(agent.cwd) &&
    agent.status === "idle" &&
    !agent.activeRunId &&
    !!agent.latestCheckpoint &&
    !metadata?.customSubagents &&
    !metadata?.localFileSystem &&
    (metadata?.initialMode == null || metadata.initialMode === "agent")
  );
}

async function readImportableRuns(
  store: LocalAgentStore,
  agentIds: string[],
): Promise<Map<string, LocalAgentRunDocument>> {
  const latest = new Map<string, LocalAgentRunDocument>();
  if (!agentIds.length) return latest;

  const pending = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.runs.list({ filter: { agentIds, cursor, limit: 500 } });
    for (const run of page.items) {
      if (run.status === "queued" || run.status === "running") pending.add(run.agentId);
      const current = latest.get(run.agentId);
      if (!current || run.turnNumber > current.turnNumber) latest.set(run.agentId, run);
    }
    cursor = page.nextCursor;
  } while (cursor);
  for (const [id, run] of latest) {
    if (pending.has(id) || run.status !== "finished" || !run.model?.id) latest.delete(id);
  }
  return latest;
}

export async function listCursorLocalSessions(
  store: LocalAgentStore,
  options: ListImportableSessionsOptions = {},
): Promise<ImportableProviderSession[]> {
  const cwd = options.cwd ? await realpath(options.cwd) : undefined;
  const { items } = await store.agents.list({
    filter: { cwd, limit: Math.min(options.scanLimit ?? 500, 500) },
  });
  const query = options.query?.trim().toLowerCase();
  const candidates = items.filter(
    (agent) =>
      canImport(agent) &&
      (!query ||
        agent.name?.toLowerCase().includes(query) ||
        basename(agent.cwd).toLowerCase().includes(query)),
  );
  const importableRuns = await readImportableRuns(
    store,
    candidates.map((agent) => agent.agentId),
  );
  return candidates
    .filter((agent) => importableRuns.has(agent.agentId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, options.limit ?? 20)
    .map((agent) => ({
      providerHandleId: agent.agentId,
      cwd: agent.cwd,
      title: agent.name ?? null,
      firstPromptPreview: null,
      lastPromptPreview: null,
      lastActivityAt: new Date(agent.updatedAt),
    }));
}

export async function readCursorLocalSessionForImport(
  store: LocalAgentStore,
  { providerHandleId, cwd }: ImportProviderSessionInput,
): Promise<{ agent: LocalAgentDocument; lastRun: LocalAgentRunDocument }> {
  if (!localAgentId.test(providerHandleId)) {
    throw new Error("Import requires a local Cursor SDK agent ID.");
  }
  const agent = await store.agents.get({ agentId: providerHandleId });
  if (!agent || agent.agentId !== providerHandleId || agent.cwd !== (await realpath(cwd))) {
    throw new Error("Cursor SDK session was not found in the host store for this workspace.");
  }
  if (!canImport(agent)) {
    throw new Error(
      "Import requires an idle Cursor SDK session with a compatible saved conversation.",
    );
  }

  const lastRun = (await readImportableRuns(store, [agent.agentId])).get(agent.agentId);
  if (!lastRun) {
    throw new Error(
      "Import requires a finished Cursor SDK run with a known model and no pending work.",
    );
  }
  return { agent, lastRun };
}
