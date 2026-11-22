import type { LocalAgentStore } from "@cursor/sdk";

type Request = <T>(method: string, input?: unknown) => Promise<T>;

/** The owner has no local persistence. Every native store call goes to the daemon. */
export function proxyCursorStore(request: Request): LocalAgentStore {
  const denied = async () => {
    throw new Error("The execution owner cannot delete persisted history.");
  };
  return {
    agents: {
      get: (input) => request("agents.get", input),
      update: (input) => request("agents.update", input),
      list: (input) => request("agents.list", input),
      create: denied,
      delete: denied,
    },
    runs: {
      get: (input) => request("runs.get", input),
      create: (input) => request("runs.create", input),
      update: (input) => request("runs.update", input),
      list: (input) => request("runs.list", input),
      delete: denied,
    },
    checkpoints: {
      get: (input) => request("checkpoints.get", input),
      create: (input) => request("checkpoints.create", input),
      update: (input) => request("checkpoints.update", input),
      list: (input) => request("checkpoints.list", input),
      delete: denied,
    },
    runEvents: {
      append: (input) => request("runEvents.append", input),
      list: (input) => request("runEvents.list", input),
      delete: denied,
    },
  };
}

/** Scope the authenticated worker to one native agent and drain accepted writes on close. */
export function serveCursorStore(
  store: LocalAgentStore,
  agentId: string,
  connected: () => boolean,
  bindRun: (runId: string) => Promise<void>,
) {
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const memberRuns = new Set<string>();

  function ensureCurrent() {
    if (closed || !connected()) throw new Error("Cursor SDK store owner was disconnected.");
  }

  function ensureAgent(id: string) {
    if (id !== agentId) throw new Error("Cursor SDK worker used a different agent identity.");
  }

  async function ensureRun(runId: string) {
    if (memberRuns.has(runId)) return;
    if (typeof runId !== "string" || !(await store.runs.get({ agentId, runId }))) {
      throw new Error("Cursor SDK worker used an unowned run.");
    }
    memberRuns.add(runId);
  }

  async function dispatch(method: string, input: unknown): Promise<unknown> {
    ensureCurrent();
    switch (method) {
      case "agents.get": {
        const args = input as Parameters<LocalAgentStore["agents"]["get"]>[0];
        ensureAgent(args.agentId);
        return store.agents.get(args);
      }
      case "agents.update": {
        const args = input as Parameters<LocalAgentStore["agents"]["update"]>[0];
        ensureAgent(args.agent.agentId);
        return store.agents.update(args);
      }
      case "agents.list": {
        const args = input as Parameters<LocalAgentStore["agents"]["list"]>[0];
        const agent = await store.agents.get({ agentId });
        return {
          items: agent && (!args?.filter?.cwd || args.filter.cwd === agent.cwd) ? [agent] : [],
        };
      }
      case "runs.get": {
        const args = input as Parameters<LocalAgentStore["runs"]["get"]>[0];
        ensureAgent(args.agentId);
        return store.runs.get(args);
      }
      case "runs.create":
      case "runs.update": {
        const args = input as Parameters<LocalAgentStore["runs"]["update"]>[0];
        ensureAgent(args.run.agentId);
        if (method === "runs.create" || args.run.status === "running")
          await bindRun(args.run.runId);
        ensureCurrent();
        const run = await store.runs[method === "runs.create" ? "create" : "update"](args);
        memberRuns.add(run.runId);
        return run;
      }
      case "runs.list": {
        const args = input as Parameters<LocalAgentStore["runs"]["list"]>[0];
        return store.runs.list({ filter: { ...args?.filter, agentIds: [agentId] } });
      }
      default:
        return dispatchBlobOrEvent(method, input);
    }
  }

  async function dispatchBlobOrEvent(method: string, input: unknown): Promise<unknown> {
    switch (method) {
      case "checkpoints.get": {
        const args = input as Parameters<LocalAgentStore["checkpoints"]["get"]>[0];
        ensureAgent(args.agentId);
        return store.checkpoints.get(args);
      }
      case "checkpoints.create":
      case "checkpoints.update": {
        const args = input as Parameters<LocalAgentStore["checkpoints"]["create"]>[0];
        ensureAgent(args.agentId);
        return store.checkpoints[method === "checkpoints.create" ? "create" : "update"](args);
      }
      case "checkpoints.list": {
        const args = input as Parameters<LocalAgentStore["checkpoints"]["list"]>[0];
        return store.checkpoints.list({ filter: { ...args?.filter, agentIds: [agentId] } });
      }
      case "runEvents.append": {
        const args = input as Parameters<LocalAgentStore["runEvents"]["append"]>[0];
        await ensureRun(args.runId);
        ensureCurrent();
        return store.runEvents.append(args);
      }
      case "runEvents.list": {
        const args = input as Parameters<LocalAgentStore["runEvents"]["list"]>[0];
        await ensureRun(args.runId);
        return store.runEvents.list(args);
      }
      default:
        throw new Error("Unsupported Cursor SDK owner store operation.");
    }
  }

  return {
    async handle(method: string, input: unknown): Promise<unknown> {
      const request = tail.catch(() => undefined).then(() => dispatch(method, input));
      tail = request;
      return request;
    },
    async close() {
      closed = true;
      await tail.catch(() => undefined);
    },
  };
}
