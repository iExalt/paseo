import { Command, Option } from "commander";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput } from "../../output/index.js";

export function createGitCommand(): Command {
  const git = new Command("git").description("Manage Git through the selected host");
  function action(name: string, description: string, destructive = false): Command {
    const command = addJsonAndDaemonHostOptions(git.command(name).description(description))
      .allowExcessArguments(false)
      .option("--workspace <id>", "Target workspace ID")
      .option("--cwd <path>", "Directory on the selected host");
    if (destructive) command.option("--force", "Confirm this operation");
    command.action(
      withOutput(async (...args: unknown[]) => {
        const options = args.at(-2);
        const { runGitCommand } = await import("./run.js");
        return runGitCommand(
          name.split(" ")[0]!,
          args.slice(0, -2),
          options as Parameters<typeof runGitCommand>[2],
        );
      }),
    );
    return command;
  }
  action("status", "Show checkout status");
  action("diff", "Show checkout or committed file diff")
    .addOption(
      new Option("--mode <mode>", "Comparison mode")
        .choices(["uncommitted", "base", "all"])
        .default("uncommitted"),
    )
    .option("--base <ref>", "Comparison base")
    .option("--ignore-whitespace", "Ignore whitespace")
    .option("--sha <sha>", "Commit to inspect (requires --path)")
    .option("--path <path>", "Committed file path (requires --sha)");
  action("log", "List checkout commits");
  action("commit", "Commit changes; generate a message when --message is omitted")
    .option("-m, --message <message>", "Commit message")
    .option("--no-add-all", "Commit staged changes only");
  action("pull", "Pull checkout");
  action("push", "Push checkout");
  action("refresh", "Refresh checkout metadata");
  action(
    "merge",
    "Merge this checkout into base, or base into this checkout with --from-base",
    true,
  )
    .option("--base <ref>", "Base ref")
    .option("--from-base", "Merge base into this checkout")
    .addOption(
      new Option("--strategy <strategy>", "Merge strategy")
        .choices(["merge", "squash"])
        .default("merge"),
    );
  action("discard <paths...>", "Discard changes to named paths", true);
  action("switch <branch>", "Switch branch");
  action("rename <branch>", "Rename current branch");
  const stash = new Command("stash").description("Manage checkout stashes");
  git.addCommand(stash);
  for (const verb of ["ls", "save", "pop"] as const) {
    const c = addJsonAndDaemonHostOptions(
      stash
        .command(verb)
        .allowExcessArguments(false)
        .option("--workspace <id>", "Target workspace ID")
        .option("--cwd <path>", "Directory on the selected host"),
    );
    if (verb === "save") c.option("--branch <branch>", "Stash branch metadata");
    if (verb === "ls") c.option("--paseo-only", "Only Paseo stashes");
    if (verb === "pop")
      c.argument("<index>", "Stash index")
        .option("--hash <hash>", "Expected stash hash")
        .option("--force", "Confirm stash application and removal");
    c.action(
      withOutput(async (...args: unknown[]) => {
        const { runGitCommand } = await import("./run.js");
        return runGitCommand(
          "stash-" + verb,
          args.slice(0, -2),
          args.at(-2) as Parameters<typeof runGitCommand>[2],
        );
      }),
    );
  }
  return git;
}
