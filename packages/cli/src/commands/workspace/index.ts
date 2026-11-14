import { Command, Option } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runArchiveCommand } from "./archive.js";
import { runCreateCommand } from "./create.js";
import { runInspectCommand } from "./inspect.js";
import { createWorkspaceLabelCommand } from "./label.js";
import { runRecoverCommand } from "./recover.js";
import { runLsCommand } from "./ls.js";
import { runRenameCommand } from "./rename.js";
import { runSetupCommand } from "./setup.js";
import { runUpdateCommand } from "./update.js";

export function createWorkspaceCommand(): Command {
  const workspace = new Command("workspace").description("Manage workspaces");

  addJsonAndDaemonHostOptions(
    workspace
      .command("setup")
      .description("Allow and run setup for a workspace")
      .argument("<workspace-id>", "Workspace id")
      .option("--status", "Read setup status without running setup"),
  ).action(withOutput(runSetupCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("create")
      .description("Create a workspace")
      .requiredOption(
        "--isolation <local|worktree>",
        "Register a local directory or create a managed worktree",
      )
      .addHelpText(
        "after",
        "\n--isolation local registers --path without creating a worktree. Returned isolation and workspace.kind reflect the directory's actual Git classification: an external linked worktree reports worktree even when registered with local. Classification does not establish Paseo ownership.",
      )
      .option("--path <path>", "Local directory or source checkout (default: current)")
      .option("--project <id>", "Existing project id")
      .option("--title <title>", "Workspace title")
      .addOption(
        new Option("--notifications <on|off>", "Workspace notifications").choices(["on", "off"]),
      )
      .option(
        "--mode <mode>",
        "Worktree mode: branch-off, checkout-branch, or checkout-pr (default: branch-off)",
      )
      .option("--worktree-slug <slug>", "Managed worktree path slug")
      .option("--new-branch <name>", "New branch name (--mode branch-off)")
      .option("--base <ref>", "Base ref (--mode branch-off)")
      .option("--branch <name>", "Existing branch (--mode checkout-branch)")
      .option("--pr-number <n>", "Pull request or change request number (--mode checkout-pr)")
      .option("--forge <forge>", "Forge for --mode checkout-pr (default: source checkout)")
      .option("--background", "Create a background workspace")
      .option("--no-background", "Create a visible workspace instead of inheriting background"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("inspect")
      .description("Inspect a workspace descriptor")
      .argument("<workspace-id>", "Exact workspace id"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("ls")
      .description("List active workspaces")
      .option("--background", "Include background workspaces"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("rename")
      .description("Set a workspace's user-visible title")
      .argument("[workspace-id]", "Workspace id")
      .argument("[title]", "New workspace title")
      .option("--reset", "Clear the title and revert to the branch or directory name")
      .option("--current", "Rename the current agent's workspace")
      // Commander 12 accepts excess positionals by default, which would rename to
      // the first word of an unquoted multi-word title and silently drop the rest.
      .allowExcessArguments(false),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("update")
      .description("Update workspace settings atomically")
      .argument("<workspace-id>", "Workspace id")
      .addOption(
        new Option("--notifications <on|off>", "Workspace notifications").choices(["on", "off"]),
      )
      .option("--background", "Hide from normal discovery")
      .option("--no-background", "Show in normal discovery")
      .addOption(new Option("--title <title>", "Workspace title").conflicts("resetTitle"))
      .addOption(
        new Option("--reset-title", "Restore the branch or directory name").conflicts("title"),
      )
      .addOption(new Option("--pin", "Pin the workspace").conflicts("unpin"))
      .addOption(new Option("--unpin", "Unpin the workspace").conflicts("pin"))
      .option("--add-label <name>", "Assign an existing label (repeatable)", collectLabels)
      .option("--remove-label <name>", "Remove a label assignment (repeatable)", collectLabels)
      .allowExcessArguments(false),
  ).action(withOutput(runUpdateCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("archive")
      .description("Archive a workspace and everything it owns")
      .addHelpText(
        "after",
        "\nExplicit archive deletes a Paseo-owned worktree, including dirty, untracked, and ignored files. External directories not owned by Paseo are preserved.\n\nArchiving your own workspace can terminate the invoking shell before a result is printed. Send the handoff first; use an external session for cleanup and verification.",
      )
      .argument("<workspace-id>", "Workspace id"),
  ).action(withOutput(runArchiveCommand));

  workspace.addCommand(createWorkspaceLabelCommand());
  addJsonAndDaemonHostOptions(
    workspace
      .command("recover")
      .allowExcessArguments(false)
      .description("Restore a recoverable workspace")
      .argument("<workspace-id>")
      .option("--inspect", "Read recovery availability without restoring"),
  ).action(withOutput(runRecoverCommand));
  return workspace;
}

function collectLabels(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
