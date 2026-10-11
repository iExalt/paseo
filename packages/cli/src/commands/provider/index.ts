import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import type { ProviderListItem, ProviderLsFullResult } from "./ls.js";
import { runModelsCommand } from "./models.js";
import type { ModelListItem, ProviderModelsFullResult } from "./models.js";
import { runDiagnosticCommand } from "./diagnostic.js";
import { addProviderInspectOptions, providerInspectOutput } from "./inspect.js";
import { withOutput } from "../../output/index.js";
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
      provider.command("inspect").description("Inspect provider capabilities and draft settings"),
    ).argument("<provider>", "Provider ID or provider/model"),
  ).action(providerInspectOutput);

  return provider;
}
