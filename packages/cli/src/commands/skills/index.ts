import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSkillSelection, AgentSkillsStatus } from "@getpaseo/protocol/messages";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput, type CommandOptions, type OutputSchema } from "../../output/index.js";

type SkillsAction = "status" | "select" | "reconcile" | "uninstall";
interface SkillsOptions extends CommandOptions {
  all?: boolean;
  none?: boolean;
}
type SkillsClient = Pick<
  DaemonClient,
  | "getLastServerInfoMessage"
  | "getAgentSkillsStatus"
  | "saveAgentSkillsSelection"
  | "reconcileAgentSkills"
  | "uninstallAgentSkills"
  | "close"
>;
const schema: OutputSchema<AgentSkillsStatus> = {
  idField: "state",
  columns: [],
  renderHuman: (result) => JSON.stringify(result.data, null, 2),
};

export function createSkillsCommand(): Command {
  const skills = new Command("skills").description("Manage daemon-provided agent skills");
  for (const action of ["status", "reconcile", "uninstall"] as const) {
    addJsonAndDaemonHostOptions(skills.command(action)).action(
      withOutput((options: CommandOptions, command: Command) =>
        runSkillsCommand(action, [], options, command),
      ),
    );
  }
  addJsonAndDaemonHostOptions(
    skills
      .command("select")
      .argument("[names...]", "Exact skill names")
      .option("--all", "Select all available skills")
      .option("--none", "Select no skills"),
  ).action(
    withOutput((names: string[], options: CommandOptions, command: Command) =>
      runSkillsCommand("select", names, options, command),
    ),
  );
  return skills;
}

export async function runSkillsCommand(
  action: SkillsAction,
  names: string[],
  options: SkillsOptions,
  _command: Command,
  connect: (options: ConnectOptions) => Promise<SkillsClient> = connectToDaemon,
) {
  let selection: AgentSkillSelection = { mode: "all" };
  if (action === "select") {
    const choices =
      Number(options.all === true) + Number(options.none === true) + Number(names.length > 0);
    if (choices !== 1 || names.some((name) => name.trim().length === 0)) {
      throw {
        code: "INVALID_SELECTION",
        message: "Choose exactly one of --all, --none, or skill names.",
      };
    }
    if (!options.all) selection = { mode: "custom", skills: names.map((name) => name.trim()) };
  }
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.skillManagement !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to manage agent skills." };
    }
    if (action === "select" && selection.mode === "custom" && !options.none) {
      const status = await client.getAgentSkillsStatus();
      const unknown = selection.skills.filter((name) => !status.available.includes(name));
      if (unknown.length > 0) {
        throw {
          code: "INVALID_SELECTION",
          message: "Unknown skill names.",
          details: { unknown, available: status.available },
        };
      }
    }
    let data: AgentSkillsStatus;
    if (action === "status") data = await client.getAgentSkillsStatus();
    else if (action === "reconcile") data = await client.reconcileAgentSkills();
    else if (action === "uninstall") data = await client.uninstallAgentSkills();
    else {
      let saved = await client.saveAgentSkillsSelection(selection);
      if (saved.confirmationRequired !== null) {
        saved = await client.saveAgentSkillsSelection(
          selection,
          saved.confirmationRequired.removals,
        );
      }
      if (saved.confirmationRequired !== null) {
        throw {
          code: "CONFIRMATION_CHANGED",
          message: "Skill removals changed during selection; inspect status and retry.",
          details: saved,
        };
      }
      data = saved;
    }
    return { type: "single" as const, data, schema };
  } finally {
    await client.close();
  }
}
