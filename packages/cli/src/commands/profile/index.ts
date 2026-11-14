import { mutateProfile } from "./mutate.js";
import { Command } from "commander";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { CommandError, CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export const profileLsSchema: OutputSchema<AgentProfile> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 18 },
    { header: "NAME", field: "name", width: 20 },
    { header: "PROVIDER", field: "provider", width: 14 },
    { header: "MODEL", field: (profile) => profile.model ?? "-", width: 24 },
    { header: "MODE", field: (profile) => profile.modeId ?? "-", width: 20 },
    { header: "THINKING", field: (profile) => profile.thinkingOptionId ?? "-", width: 16 },
    { header: "NOTES", field: (profile) => profile.notes ?? "" },
  ],
};

export interface ProfileLsOptions extends CommandOptions {
  host?: string;
}

export async function runProfileLsCommand(
  options: ProfileLsOptions,
  _command: Command,
): Promise<ListResult<AgentProfile>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(profileList): added in v0.11.2, remove gate after 2027-04-10 once daemon floor >= v0.11.2.
    if (client.getLastServerInfoMessage()?.features?.profileList !== true) {
      throw {
        code: "UNSUPPORTED_FEATURE",
        message: "The connected daemon does not support profile listing.",
        details: "Update the daemon before listing saved profiles.",
      } satisfies CommandError;
    }
    const { profiles } = await client.listAgentProfiles();
    return {
      type: "list",
      data: profiles,
      schema: profileLsSchema,
    };
  } finally {
    await client.close();
  }
}

export function createProfileCommand(): Command {
  const profile = new Command("profile").description("Manage saved agent launch profiles");
  addJsonAndDaemonHostOptions(
    profile.command("ls").description("List saved agent profiles"),
  ).action(withOutput(runProfileLsCommand));
  addJsonAndDaemonHostOptions(
    profile
      .command("add <config-json>")
      .description("Create a saved profile (id optional; name/provider required)"),
  ).action(
    withOutput((raw: string, options: CommandOptions, _command: Command) =>
      mutateProfile("add", undefined, raw, options),
    ),
  );
  addJsonAndDaemonHostOptions(
    profile
      .command("update <id> <config-json>")
      .description("Edit profile fields; featureValues replaces that field"),
  ).action(
    withOutput((id: string, raw: string, options: CommandOptions, _command: Command) =>
      mutateProfile("update", id, raw, options),
    ),
  );
  addJsonAndDaemonHostOptions(
    profile.command("rm <id>").description("Remove a saved profile"),
  ).action(
    withOutput((id: string, options: CommandOptions, _command: Command) =>
      mutateProfile("rm", id, undefined, options),
    ),
  );
  return profile;
}
