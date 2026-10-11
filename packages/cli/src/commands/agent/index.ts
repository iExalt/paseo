import { Command } from "commander";
import { runModeCommand } from "./mode.js";
import { addArchiveOptions, runArchiveCommand } from "./archive.js";
import { addDeleteOptions, runDeleteCommand } from "./delete.js";
import { addLsOptions, runLsCommand } from "./ls.js";
import { addRunOptions, runRunCommand } from "./run.js";
import { addLogsOptions, runLogsCommand } from "./logs.js";
import { addStopOptions, runStopCommand } from "./stop.js";
import { addSendOptions, runSendCommand } from "./send.js";
import { addInspectOptions, runInspectCommand } from "./inspect.js";
import { addWaitOptions, runWaitCommand } from "./wait.js";
import { addAttachOptions, runAttachCommand } from "./attach.js";
import { addReloadOptions, runReloadCommand } from "./reload.js";
import { addImportOptions, runImportCommand } from "./import.js";
import { runUpdateCommand } from "./update.js";
import { runDetachCommand } from "./detach.js";
import { addCloseOptions, runCloseCommand } from "./close.js";
import { addAgentQueryOptions, runAgentQueryCommand } from "./query.js";
import { addAgentStatusOptions, runAgentStatusCommand } from "./status.js";
import { addAgentActivityOptions, runAgentActivityCommand } from "./activity.js";
import { addOpenOptions, runOpenCommand } from "./open.js";
import { withOutput } from "../../output/index.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  collectMultiple,
  withGlobalOptions,
} from "../../utils/command-options.js";

export function createAgentCommand(): Command {
  const agent = new Command("agent").description("Manage agents (advanced operations)");

  // Primary agent commands (same as top-level)
  addJsonAndDaemonHostOptions(addLsOptions(agent.command("ls"))).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(addAgentQueryOptions(agent.command("query"))).action(
    withOutput(runAgentQueryCommand),
  );

  addJsonAndDaemonHostOptions(addAgentStatusOptions(agent.command("status"))).action(
    withOutput(runAgentStatusCommand),
  );

  addJsonAndDaemonHostOptions(addAgentActivityOptions(agent.command("activity"))).action(
    withOutput(runAgentActivityCommand),
  );

  addJsonAndDaemonHostOptions(addRunOptions(agent.command("run"))).action(
    withOutput(runRunCommand),
  );

  addJsonAndDaemonHostOptions(addImportOptions(agent.command("import"))).action(
    withOutput(runImportCommand),
  );

  addDaemonHostOption(addAttachOptions(agent.command("attach"))).action(
    withGlobalOptions(runAttachCommand),
  );

  addDaemonHostOption(addLogsOptions(agent.command("logs"))).action(
    withGlobalOptions(runLogsCommand),
  );

  addJsonAndDaemonHostOptions(addOpenOptions(agent.command("open"))).action(
    withOutput(runOpenCommand),
  );

  addJsonAndDaemonHostOptions(addStopOptions(agent.command("stop"))).action(
    withOutput(runStopCommand),
  );

  addJsonAndDaemonHostOptions(addDeleteOptions(agent.command("delete"))).action(
    withOutput(runDeleteCommand),
  );

  addJsonAndDaemonHostOptions(addCloseOptions(agent.command("close"))).action(
    withOutput(runCloseCommand),
  );

  addJsonAndDaemonHostOptions(addSendOptions(agent.command("send"))).action(
    withOutput(runSendCommand),
  );

  addJsonAndDaemonHostOptions(addInspectOptions(agent.command("inspect"))).action(
    withOutput(runInspectCommand),
  );

  addJsonAndDaemonHostOptions(addWaitOptions(agent.command("wait"))).action(
    withOutput(runWaitCommand),
  );

  // Advanced agent commands (less common operations)
  addJsonAndDaemonHostOptions(
    agent
      .command("mode")
      .description("Change an agent's operational mode")
      .argument("<id>", "Agent ID (or prefix)")
      .argument("[mode]", "Mode to set (required unless --list)")
      .option("--list", "List available modes for this agent"),
  ).action(withOutput(runModeCommand));

  addJsonAndDaemonHostOptions(addArchiveOptions(agent.command("archive"))).action(
    withOutput(runArchiveCommand),
  );

  addJsonAndDaemonHostOptions(addReloadOptions(agent.command("reload"))).action(
    withOutput(runReloadCommand),
  );

  addJsonAndDaemonHostOptions(
    agent
      .command("detach")
      .description("Make a subagent independent without stopping or moving it")
      .argument("<id>", "Agent ID, prefix, or name"),
  ).action(withOutput(runDetachCommand));

  addJsonAndDaemonHostOptions(
    agent
      .command("update")
      .description("Update an agent's settings or metadata")
      .argument("<id>", "Agent ID (or prefix)")
      .option("--name <name>", "Update the agent's display name")
      .option("--mode <id>", "Update the agent's provider mode ID")
      .option("--model <id>", "Update the agent's model ID")
      .option("--clear-model", "Clear the agent's model override")
      .option("--thinking <id>", "Update the agent's thinking option ID")
      .option("--clear-thinking", "Clear the agent's thinking option override")
      .option(
        "--feature <id=value>",
        "Set provider feature values (repeatable or comma-separated; use true, false, null, or strings)",
        collectMultiple,
        [],
      )
      .option("--features-json <object>", "Set provider feature values from a JSON object")
      .option(
        "--label <label>",
        "Add/set label(s) on the agent (can be used multiple times or comma-separated)",
        collectMultiple,
        [],
      ),
  ).action(withOutput(runUpdateCommand));

  return agent;
}
