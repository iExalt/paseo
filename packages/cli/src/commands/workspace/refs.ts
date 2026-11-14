import type { Command } from "commander";
import {
  ForgeSearchItemSchema,
  type BranchSuggestionsResponse,
  type ForgeSearchItem,
  type ForgeSearchResponse,
  type ValidateBranchResponse,
} from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { resolveRepositoryDirectory } from "../worktree/repository-directory.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
interface RefsOptions {
  daemonTarget: DaemonTarget;
  path?: string;
  query?: string;
  kind?: "pr" | "branch";
}
interface PullRequestSearch extends Omit<ForgeSearchResponse["payload"], "items"> {
  items: ForgeSearchItem[];
}
interface RefsResult {
  cwd: string;
  branches: BranchSuggestionsResponse["payload"] | null;
  pullRequests: PullRequestSearch | null;
}
const schema: OutputSchema<RefsResult> = {
  idField: "cwd",
  columns: [
    { header: "CWD", field: "cwd", width: 36 },
    { header: "BRANCHES", field: (row) => row.branches?.branches.join(", ") ?? "", width: 40 },
    {
      header: "PULL REQUESTS",
      field: (row) =>
        row.pullRequests?.items.map((item) => `#${item.number} ${item.title}`).join("; ") ?? "",
      width: 60,
    },
  ],
};
export async function runRefsCommand(
  options: RefsOptions,
  _command: Command,
): Promise<SingleResult<RefsResult>> {
  const cwd = resolveRepositoryDirectory({ cwd: options.path, daemonTarget: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const searchesPrs = options.kind !== "branch";
    // COMPAT(forgeSearch): added in v0.2.0-beta.1, remove gate after 2027-01-17.
    if (searchesPrs && !client.getLastServerInfoMessage()?.features?.forgeSearch)
      throw { code: "DAEMON_UPDATE_REQUIRED", message: "Update the host to search pull requests." };
    let branches: RefsResult["branches"] = null;
    let pullRequests: RefsResult["pullRequests"] = null;
    const query = options.query ?? "";
    if (options.kind !== "pr") {
      branches = await client.getBranchSuggestions({ cwd, query, limit: 50 });
      if (branches.error) throw { code: "BRANCH_SEARCH_FAILED", message: branches.error };
    }
    if (searchesPrs) {
      const payload = await client.searchForge({
        cwd,
        query,
        limit: 50,
        kinds: ["change_request"],
      });
      if (payload.error) throw { code: "PR_SEARCH_FAILED", message: payload.error };
      pullRequests = {
        ...payload,
        items: payload.items.map((item) => ForgeSearchItemSchema.parse(item)),
      };
    }
    return { type: "single", data: { cwd, branches, pullRequests }, schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
interface ValidationResult extends Omit<ValidateBranchResponse["payload"], "requestId"> {
  cwd: string;
  branch: string;
}
const validationSchema: OutputSchema<ValidationResult> = {
  idField: "branch",
  columns: [
    { header: "BRANCH", field: "branch", width: 30 },
    { header: "EXISTS", field: "exists", width: 8 },
    { header: "RESOLVED REF", field: "resolvedRef", width: 40 },
    { header: "REMOTE", field: "isRemote", width: 8 },
  ],
};
export async function runValidateBranchCommand(
  branch: string,
  options: RefsOptions,
  _command: Command,
): Promise<SingleResult<ValidationResult>> {
  if (!branch.trim()) throw { code: "INVALID_OPTIONS", message: "Branch cannot be empty" };
  const cwd = resolveRepositoryDirectory({ cwd: options.path, daemonTarget: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const { exists, resolvedRef, isRemote, error } = await client.validateBranch({
      cwd,
      branchName: branch,
    });
    if (error) throw { code: "BRANCH_VALIDATION_FAILED", message: error };
    return {
      type: "single",
      data: { cwd, branch, exists, resolvedRef, isRemote, error },
      schema: validationSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
