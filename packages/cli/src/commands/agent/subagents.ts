import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { resolveAgentTarget } from "../../utils/agent-target.js";
import { fetchAllAgents } from "../../utils/agent-directory.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { addJsonAndDaemonHostOptions, withGlobalOptions } from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";
import { formatAgentActivityTranscript, parseTimelineOptions } from "./logs.js";

export function createSubagentsCommand(): Command {
  const command = addJsonAndDaemonHostOptions(
    new Command("subagents")
      .description("List Paseo children and provider-native subagents")
      .argument("[parent]", "Parent agent ID, prefix, or full session ID"),
  );
  command.action(withGlobalOptions(runSubagentsCommand));
  addJsonAndDaemonHostOptions(
    command
      .command("timeline")
      .description("Read a provider-native subagent timeline")
      .argument("<parent>", "Parent Paseo agent ID")
      .argument("<sub>", "Provider-native subagent ID")
      .option("--limit <n>", "Maximum rows (0 means all)")
      .option("--before <epoch:seq>", "Read older rows before this cursor"),
  ).action(withGlobalOptions(runSubagentTimelineCommand));
  return command;
}

export async function runSubagentsCommand(
  parent: string | undefined,
  options: CommandOptions,
): Promise<void> {
  if (!parent?.trim())
    throw { code: "MISSING_AGENT_ID", message: "Usage: paseo agent subagents <parent>" };
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const parentAgentId = await resolveAgentTarget(client, parent);
    const paseoChildren = await fetchAllAgents(client, {
      filter: {
        includeArchived: true,
        includeBackground: true,
        labels: { [PARENT_AGENT_ID_LABEL]: parentAgentId },
      },
    });
    const native = await client.listProviderSubagents(parentAgentId);
    const result = { parentAgentId, paseoChildren, providerSubagents: native.subagents };
    if (options.json || options.format === "json") console.log(JSON.stringify(result));
    else {
      console.log(`Parent: ${parentAgentId}`);
      for (const child of paseoChildren)
        console.log(`paseo\t${child.id}\t${child.status}\t${child.title ?? ""}`);
      for (const child of native.subagents)
        console.log(`provider\t${child.id}\t${child.status}\t${child.title ?? ""}`);
    }
  } finally {
    await client.close();
  }
}

async function runSubagentTimelineCommand(
  parent: string,
  sub: string,
  options: CommandOptions,
): Promise<void> {
  const parsed = parseTimelineOptions({
    ...options,
    limit: typeof options.limit === "string" ? options.limit : undefined,
    before: typeof options.before === "string" ? options.before : undefined,
  });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const parentAgentId = await resolveAgentTarget(client, parent);
    const result = await client.fetchProviderSubagentTimeline(parentAgentId, sub, {
      direction: parsed.cursor ? "before" : "tail",
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
    if (options.json || options.format === "json") console.log(JSON.stringify(result));
    else console.log(formatAgentActivityTranscript(result.rows.map((row) => row.item)));
  } finally {
    await client.close();
  }
}
