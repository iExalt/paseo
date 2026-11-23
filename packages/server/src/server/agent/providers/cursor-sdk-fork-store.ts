import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LocalAgentStore, LocalAgentStoreListResult } from "@cursor/sdk";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const linkSchema = z.object({ agentId: z.string(), parentId: z.string() });
// The SDK's own checkpoint listing pages 50 blob IDs at a time.
const DEFAULT_PAGE = 50;

/**
 * Paseo-owned links from a rewound local agent to the agent it was forked from.
 * A fork stores only the checkpoint blobs it writes itself and reads the rest
 * from its ancestors, so a rewind never copies the conversation's blobs.
 */
export class CursorForkLinks {
  private readonly directory: string;
  private readonly parents = new Map<string, Promise<string | null>>();

  constructor(root: string) {
    this.directory = join(root, "paseo-forks");
  }

  private path(agentId: string): string {
    return join(this.directory, `${createHash("sha256").update(agentId).digest("hex")}.json`);
  }

  async link(agentId: string, parentId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeJsonFileAtomic(this.path(agentId), { agentId, parentId });
    this.parents.set(agentId, Promise.resolve(parentId));
  }

  async unlink(agentId: string): Promise<void> {
    this.parents.delete(agentId);
    await rm(this.path(agentId), { force: true });
  }

  private parent(agentId: string): Promise<string | null> {
    let parent = this.parents.get(agentId);
    if (!parent) {
      parent = readFile(this.path(agentId), "utf8").then(
        (data) => {
          const link = linkSchema.parse(JSON.parse(data));
          if (link.agentId !== agentId)
            throw new Error(`Cursor SDK fork link mismatch for ${agentId}`);
          return link.parentId;
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      this.parents.set(agentId, parent);
      parent.catch(() => this.parents.delete(agentId));
    }
    return parent;
  }

  /** The agent followed by its ancestors, nearest first. */
  async lineage(agentId: string): Promise<string[]> {
    const chain = [agentId];
    for (let parent = await this.parent(agentId); parent; parent = await this.parent(parent)) {
      if (chain.includes(parent)) throw new Error(`Cursor SDK fork links loop at ${parent}`);
      chain.push(parent);
    }
    return chain;
  }
}

function paginate(
  ids: string[],
  cursor?: string,
  limit = DEFAULT_PAGE,
): LocalAgentStoreListResult<string> {
  const remaining = cursor ? ids.filter((id) => id > cursor) : ids;
  const items = remaining.slice(0, limit);
  const last = items.at(-1);
  return remaining.length > limit && last ? { items, nextCursor: last } : { items };
}

/** Wraps a store so each forked agent sees its ancestors' checkpoint blobs as its own. */
export function withCursorForkBlobs(
  store: LocalAgentStore,
  links: CursorForkLinks,
): LocalAgentStore {
  const { checkpoints } = store;
  async function own(agentId: string, blobId: string) {
    return checkpoints.get({ agentId, blobId });
  }
  async function listAll(agentId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await checkpoints.list({ filter: { agentIds: [agentId], cursor } });
      ids.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }
  return {
    agents: store.agents,
    runs: store.runs,
    runEvents: store.runEvents,
    checkpoints: {
      async get(input) {
        for (const agentId of await links.lineage(input.agentId)) {
          const data = await own(agentId, input.blobId);
          if (data) return data;
        }
        return null;
      },
      create: (input) => checkpoints.create(input),
      async update(input) {
        // A blob read through an ancestor is not yet the fork's own row.
        if (await own(input.agentId, input.blobId)) return checkpoints.update(input);
        return checkpoints.create(input);
      },
      delete: (input) => checkpoints.delete(input),
      async list(input) {
        const filter = input?.filter;
        const agentId = filter?.agentIds?.length === 1 ? filter.agentIds[0] : undefined;
        if (!agentId || filter?.blobIds?.length) return checkpoints.list(input);
        const lineage = await links.lineage(agentId);
        if (lineage.length === 1) return checkpoints.list(input);
        const ids = new Set<string>();
        for (const id of lineage) for (const blobId of await listAll(id)) ids.add(blobId);
        return paginate([...ids].sort(), filter?.cursor, filter?.limit);
      },
    },
  };
}
