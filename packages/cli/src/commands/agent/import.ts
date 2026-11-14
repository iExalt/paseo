import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Command } from "commander";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { collectMultiple } from "../../utils/command-options.js";
import type {
  CommandError,
  CommandOptions,
  SingleResult,
  OutputSchema,
} from "../../output/index.js";
import { agentRunSchema, type AgentRunResult } from "./run.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

export function addImportOptions(cmd: Command): Command {
  return cmd
    .description("Import an existing provider session as a Paseo agent")
    .argument("[id]", "Provider session/thread ID to import")
    .option("--list", "List recent provider sessions available to import")
    .option("--provider <provider>", "Agent provider id")
    .option("--cwd <path>", "Working directory for providers that require it")
    .option(
      "--label <key=value>",
      "Add label(s) to the agent (can be used multiple times)",
      collectMultiple,
      [],
    );
}

export interface AgentImportOptions extends CommandOptions {
  list?: boolean;
  provider?: string;
  cwd?: string;
  label?: string[];
  host?: string;
}

type RecentSessions = Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>;
export type AgentImportData = AgentRunResult | RecentSessions;
export type AgentImportCommandResult = SingleResult<AgentRunResult> | SingleResult<RecentSessions>;
const discoverySchema: OutputSchema<RecentSessions> = {
  idField: () => "sessions",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};

function toImportResult(agent: AgentSnapshotPayload): AgentRunResult {
  return {
    agentId: agent.id,
    status: agent.status === "running" ? "running" : "created",
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  };
}

function parseImportProvider(provider: string | undefined): string {
  const normalizedProvider = provider?.trim();
  if (!normalizedProvider) {
    throw {
      code: "MISSING_PROVIDER",
      message: "Provider is required",
      details: "Usage: paseo import --provider <provider> <id>",
    } satisfies CommandError;
  }

  return normalizedProvider;
}

function parseImportLabels(labelFlags: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!labelFlags) {
    return labels;
  }

  for (const labelFlag of labelFlags) {
    const eqIndex = labelFlag.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelFlag}`,
        details: "Labels must be in key=value format",
      } satisfies CommandError;
    }

    const key = labelFlag.slice(0, eqIndex).trim();
    if (!key) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelFlag}`,
        details: "Labels must include a non-empty key in key=value format",
      } satisfies CommandError;
    }

    labels[key] = labelFlag.slice(eqIndex + 1);
  }

  return labels;
}

export function resolveImportCwd(explicitCwd: string | undefined, defaultCwd: string): string {
  const cwd = explicitCwd?.trim() ?? defaultCwd;
  if (!cwd.trim()) {
    throw {
      code: "INVALID_CWD",
      message: "--cwd cannot be empty",
      details: "Provide a working directory path or omit --cwd",
    } satisfies CommandError;
  }
  return cwd;
}

export async function runImportCommand(
  sessionIdArg: string | undefined,
  options: AgentImportOptions,
  _command: Command,
): Promise<AgentImportCommandResult> {
  if (options.list) {
    if (sessionIdArg !== undefined || (options.label?.length ?? 0) > 0) {
      throw {
        code: "INVALID_OPTIONS",
        message: "--list cannot be combined with a session ID or labels.",
      };
    }
    return runImportDiscovery(options, _command);
  }
  const sessionId = sessionIdArg?.trim();
  if (!sessionId) {
    throw {
      code: "MISSING_SESSION_ID",
      message: "Session ID is required",
      details: "Usage: paseo import --provider <provider> <id>",
    } satisfies CommandError;
  }

  const provider = parseImportProvider(options.provider);
  const cwd = resolveImportCwd(options.cwd, process.cwd());

  const labels = parseImportLabels(options.label);
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const agent = await client.importAgent({
      provider,
      sessionId,
      cwd,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    });

    await client.close();

    return {
      type: "single",
      data: toImportResult(agent),
      schema: agentRunSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "AGENT_IMPORT_FAILED",
      message: `Failed to import agent: ${message}`,
    } satisfies CommandError;
  }
}

export async function runImportDiscovery(
  options: AgentImportOptions,
  _command: Command,
  connect: (
    options: ConnectOptions,
  ) => Promise<Pick<DaemonClient, "fetchRecentProviderSessions" | "close">> = connectToDaemon,
): Promise<SingleResult<RecentSessions>> {
  const provider =
    options.provider === undefined ? undefined : parseImportProvider(options.provider);
  const cwd = options.cwd?.trim();
  if (options.cwd !== undefined && !cwd)
    throw { code: "INVALID_CWD", message: "--cwd cannot be empty." };
  const client = await connect({ target: options.daemonTarget });
  try {
    const data = await client.fetchRecentProviderSessions({
      cwd,
      providers: provider === undefined ? undefined : [provider],
    });
    return { type: "single", data, schema: discoverySchema };
  } finally {
    await client.close();
  }
}
