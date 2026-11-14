import { runProviderCommandsCommand } from "../agent/commands.js";
import { runProviderFeaturesCommand } from "./features.js";
import { runRefreshCommand } from "./refresh.js";
import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import type { ProviderListItem, ProviderLsFullResult } from "./ls.js";
import { runModelsCommand } from "./models.js";
import type { ModelListItem, ProviderModelsFullResult } from "./models.js";
import { runDiagnosticCommand } from "./diagnostic.js";
import { addProviderInspectOptions, providerInspectOutput } from "./inspect.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createProviderCommand(): Command {
  const provider = new Command("provider").description("Manage agent providers");

  addJsonAndDaemonHostOptions(
    provider
      .command("ls")
      .description("List available providers and status")
      .option("--full", "Return the canonical provider records as a JSON object"),
  ).action(withOutput<ProviderListItem | ProviderLsFullResult, []>(runLsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name (claude, codex, opencode)")
      .option("--thinking", "Include thinking option IDs for each model")
      .option("--full", "Return the canonical model records as a JSON object"),
  ).action(withOutput<ModelListItem | ProviderModelsFullResult, [string]>(runModelsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("diagnostic")
      .description("Show provider installation, environment, and availability diagnostics")
      .argument("<provider>", "Provider name"),
  ).action(withOutput(runDiagnosticCommand));

  addProviderInspectOptions(
    addJsonAndDaemonHostOptions(
      provider
        .command("inspect")
        .alias("modes")
        .description("Inspect provider modes, capabilities, and draft settings"),
    ).argument("<provider>", "Provider ID or provider/model"),
  ).action(providerInspectOutput);

  addJsonAndDaemonHostOptions(
    provider
      .command("refresh")
      .description("Refresh provider discovery")
      .argument("[provider]", "Refresh only this provider")
      .option("--cwd <path>", "Daemon-side working directory"),
  ).action(
    withOutput((providerId: string | undefined, options: CommandOptions, command: Command) =>
      runRefreshCommand(providerId, options, command),
    ),
  );
  addJsonAndDaemonHostOptions(
    provider
      .command("features")
      .description("List features for a provider draft")
      .argument("<provider>", "Provider ID")
      .requiredOption("--cwd <path>", "Daemon-side working directory")
      .option("--mode <id>", "Mode ID")
      .option("--model <id>", "Model ID")
      .option("--thinking <id>", "Thinking option ID"),
  ).action(
    withOutput((providerId: string, options: CommandOptions, command: Command) =>
      runProviderFeaturesCommand(providerId, options, command),
    ),
  );
  addJsonAndDaemonHostOptions(
    provider
      .command("commands")
      .description("List slash commands and skills for a draft provider configuration")
      .argument("<provider>", "Provider ID or provider/model")
      .requiredOption("--cwd <path>", "Working directory on the selected host")
      .option("--mode <id>", "Draft provider mode")
      .option("--model <id>", "Draft model")
      .option("--thinking <id>", "Draft thinking option"),
  ).action(
    withOutput(
      (id: string, options: Parameters<typeof runProviderCommandsCommand>[1], command: Command) =>
        runProviderCommandsCommand(id, options, command),
    ),
  );
  return provider;
}
