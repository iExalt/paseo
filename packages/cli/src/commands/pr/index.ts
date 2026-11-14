import { Command, Option } from "commander";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput } from "../../output/index.js";
export function createPrCommand(): Command {
  const pr = new Command("pr").description(
    "Manage pull requests through the selected host's forge",
  );
  for (const verb of [
    "status",
    "checks",
    "check",
    "timeline",
    "create",
    "merge",
    "auto-merge",
  ] as const) {
    const command = addJsonAndDaemonHostOptions(
      pr
        .command(verb)
        .allowExcessArguments(false)
        .option("--workspace <id>", "Target workspace ID")
        .option("--cwd <path>", "Directory on the selected host"),
    );
    if (verb === "create")
      command
        .option("--title <title>", "PR title; generated if omitted")
        .option("--body <body>", "PR body; generated if omitted")
        .option("--base <ref>", "Base branch");
    if (verb === "check")
      command
        .option("--check-run-id <id>", "Check run ID")
        .option("--workflow-run-id <id>", "Workflow run ID");
    if (verb === "timeline" || verb === "check")
      command
        .option("--number <number>", "Override current PR number")
        .option("--repo-owner <owner>", "Override repository owner")
        .option("--repo-name <name>", "Override repository name");
    if (verb === "merge" || verb === "auto-merge") {
      command.addOption(
        new Option("--method <method>", "Merge method")
          .choices(["merge", "squash", "rebase"])
          .default("squash"),
      );
    }
    if (verb === "auto-merge")
      command.option("--disable", "Disable auto-merge instead of enabling");
    command.action(
      withOutput(async (...args: unknown[]) => {
        const { runPrCommand } = await import("./run.js");
        return runPrCommand(verb, args.at(-2) as Parameters<typeof runPrCommand>[1]);
      }),
    );
  }
  return pr;
}
