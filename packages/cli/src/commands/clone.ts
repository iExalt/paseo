import { Command, Option } from "commander";
import { isCompleteGitRemote } from "@getpaseo/protocol/git-remote";
import { connectToDaemon } from "../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../output/index.js";
import { withOutput, type ListResult } from "../output/index.js";
import { addJsonAndDaemonHostOptions } from "../utils/command-options.js";
import type { WorkspaceGithubSearchRepositoriesResponse } from "@getpaseo/protocol/messages";
import type { CommandOptions } from "../output/with-output.js";

type CloneProtocol = "https" | "ssh";

interface CloneCommandOptions extends CommandOptions {
  protocol?: CloneProtocol;
  search?: string;
}

export interface CloneResult {
  repo: string;
  checkoutPath: string;
  projectId: string;
  projectName: string;
}

export const cloneSchema: OutputSchema<CloneResult> = {
  idField: "projectId",
  columns: [
    { header: "REPO", field: "repo", width: 28 },
    { header: "PROJECT", field: "projectName", width: 28 },
    { header: "PATH", field: "checkoutPath", width: 56 },
  ],
};

function cmdError(code: string, message: string, details?: string): CommandError {
  return details ? { code, message, details } : { code, message };
}

export async function runCloneCommand(
  repo: string | undefined,
  options: CloneCommandOptions,
  _command: Command,
): Promise<SingleResult<CloneResult>> {
  if (!repo?.trim())
    throw cmdError("INVALID_ARGUMENT", "Repository is required unless --search is selected");
  const targetDirectory = typeof options.dir === "string" ? options.dir.trim() : "";
  if (!targetDirectory) {
    throw cmdError("INVALID_ARGUMENT", "--dir is required");
  }
  const repoIsCompleteRemote = isCompleteGitRemote(repo);
  if (!repoIsCompleteRemote && !options.protocol) {
    throw cmdError("INVALID_ARGUMENT", "--protocol is required for owner/repo repository names");
  }

  const client = await connectToDaemon({ target: options.daemonTarget });

  if (client.getLastServerInfoMessage()?.features?.projectGithubClone !== true) {
    await client.close().catch(() => {});
    throw cmdError(
      "UNSUPPORTED_BY_HOST",
      "This daemon does not support cloning GitHub repos.",
      "Update the host to a newer Paseo version.",
    );
  }

  try {
    const response = await client.cloneGithubProject({
      repo,
      targetDirectory,
      ...(repoIsCompleteRemote ? {} : { cloneProtocol: options.protocol }),
    });
    if (response.error || !response.project || !response.checkoutPath) {
      throw cmdError(
        "CLONE_FAILED",
        `Failed to clone GitHub repo: ${response.error ?? "no project returned"}`,
      );
    }

    return {
      type: "single",
      data: {
        repo: response.repo,
        checkoutPath: response.checkoutPath,
        projectId: response.project.projectId,
        projectName: response.project.projectDisplayName,
      },
      schema: cloneSchema,
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw cmdError("CLONE_FAILED", `Failed to clone GitHub repo: ${message}`);
  } finally {
    await client.close().catch(() => {});
  }
}

type Repository = WorkspaceGithubSearchRepositoriesResponse["payload"]["repositories"][number];
const repositorySchema: OutputSchema<Repository> = {
  idField: "nameWithOwner",
  columns: [
    { header: "REPOSITORY", field: "nameWithOwner", width: 36 },
    { header: "VISIBILITY", field: "visibility", width: 12 },
    { header: "DESCRIPTION", field: "description", width: 60 },
  ],
};
export async function runCloneSearchCommand(
  repo: string | undefined,
  options: CloneCommandOptions,
  _command: Command,
): Promise<ListResult<Repository>> {
  const query = options.search?.trim();
  if (!query) throw cmdError("INVALID_ARGUMENT", "--search requires a nonempty query");
  if (repo !== undefined || options.dir !== undefined || options.protocol !== undefined)
    throw cmdError(
      "INVALID_ARGUMENT",
      "--search cannot be combined with a repository, --dir, or --protocol",
    );
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
    if (!client.getLastServerInfoMessage()?.features?.workspaceGithubRepositorySearch)
      throw cmdError("UNSUPPORTED_BY_HOST", "Update the host to search GitHub repositories.");
    const payload = await client.searchGithubRepositories({ query, limit: 30 });
    if (payload.status !== "success")
      throw cmdError(`REPOSITORY_SEARCH_${payload.status.toUpperCase()}`, payload.error);
    return { type: "list", data: payload.repositories, schema: repositorySchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
export function createCloneCommand(): Command {
  const command = addJsonAndDaemonHostOptions(
    new Command("clone")
      .description("Clone a GitHub repo or search repositories")
      .allowExcessArguments(false)
      .argument("[repo]", "GitHub owner/repo or full git remote URL")
      .option("--dir <path>", "Parent directory to clone into (required when cloning)")
      .option("--search <query>", "Search GitHub repositories without cloning")
      .addOption(
        new Option("--protocol <protocol>", "Protocol for owner/repo shorthand").choices([
          "https",
          "ssh",
        ]),
      ),
  );
  return command.action((repo, options, actionCommand) => {
    if (options.search !== undefined)
      return withOutput(runCloneSearchCommand)(repo, options, actionCommand);
    return withOutput(runCloneCommand)(repo, options, actionCommand);
  });
}
