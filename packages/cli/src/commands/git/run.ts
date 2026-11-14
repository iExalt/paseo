import { resolve } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

export interface GitOptions extends CommandOptions {
  workspace?: string;
  cwd?: string;
  mode?: "uncommitted" | "base" | "all";
  base?: string;
  ignoreWhitespace?: boolean;
  sha?: string;
  path?: string;
  message?: string;
  addAll?: boolean;
  fromBase?: boolean;
  strategy?: "merge" | "squash";
  branch?: string;
  paseoOnly?: boolean;
  hash?: string;
}
export type CheckoutOutput = Record<string, unknown>;
const schema: OutputSchema<CheckoutOutput> = {
  idField: (row) => String(row.cwd ?? ""),
  columns: [{ header: "RESULT", field: (row) => JSON.stringify(row) }],
};
export function checkoutResult(payload: object): SingleResult<CheckoutOutput> {
  const data = { ...payload } as CheckoutOutput;
  if (data.error || data.success === false) {
    const error = data.error;
    throw {
      code: "CHECKOUT_OPERATION_FAILED",
      message:
        typeof error === "object" && error && "message" in error
          ? String(error.message)
          : String(error ?? "Checkout operation failed"),
      details: data,
    };
  }
  return { type: "single", data, schema };
}
export function requireFeature(
  client: DaemonClient,
  feature: keyof NonNullable<
    NonNullable<ReturnType<DaemonClient["getLastServerInfoMessage"]>>["features"]
  >,
): void {
  if (!client.getLastServerInfoMessage()?.features?.[feature]) {
    throw { code: "DAEMON_UPDATE_REQUIRED", message: "Update the host to use " + feature };
  }
}
export async function resolveCheckoutCwd(
  client: DaemonClient,
  options: GitOptions,
): Promise<string> {
  if (options.workspace && options.cwd)
    throw { code: "INVALID_OPTIONS", message: "Choose --workspace or --cwd" };
  const workspace =
    options.workspace ?? (!options.cwd ? process.env.PASEO_WORKSPACE_ID : undefined);
  if (workspace) {
    const { resolveExistingRunWorkspace } = await import("../agent/run.js");
    return (await resolveExistingRunWorkspace(client, workspace)).cwd;
  }
  if (options.cwd) return options.cwd;
  if (options.daemonTarget.kind === "endpoint")
    throw { code: "MISSING_TARGET", message: "Pass --workspace or --cwd for a remote host" };
  return resolve(process.cwd());
}
export async function runGitCommand(
  operation: string,
  args: unknown[],
  options: GitOptions,
  connect: typeof connectToDaemon = connectToDaemon,
): Promise<SingleResult<CheckoutOutput>> {
  if (operation === "diff" && Boolean(options.sha) !== Boolean(options.path))
    throw { code: "INVALID_OPTIONS", message: "--sha and --path must be used together" };
  const index = operation === "stash-pop" ? Number(args[0]) : 0;
  if (operation === "stash-pop" && (!Number.isSafeInteger(index) || index < 0))
    throw { code: "INVALID_OPTIONS", message: "Stash index must be a non-negative integer" };
  if (operation === "merge" && options.fromBase && options.strategy === "squash")
    throw { code: "INVALID_OPTIONS", message: "--from-base does not support --strategy squash" };
  const client = await connect({ target: options.daemonTarget });
  try {
    const cwd = await resolveCheckoutCwd(client, options);
    const payload = await executeGitOperation(client, cwd, operation, args, options);
    return checkoutResult({
      ...payload,
      cwd,
      operation,
      ...(operation === "discard" ? { paths: args[0] } : {}),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function executeGitOperation(
  client: DaemonClient,
  cwd: string,
  operation: string,
  args: unknown[],
  options: GitOptions,
): Promise<object> {
  let payload: object;
  switch (operation) {
    case "status":
      payload = await client.getCheckoutStatus(cwd);
      break;
    case "diff":
      if (options.sha && options.path)
        payload = await client.getCommitFileDiff(cwd, options.sha, options.path);
      else {
        if (options.mode === "all") requireFeature(client, "checkoutDiffAll");
        payload = await client.getCheckoutDiff(cwd, {
          mode: options.mode ?? "uncommitted",
          baseRef: options.base,
          ignoreWhitespace: options.ignoreWhitespace,
        });
      }
      break;
    case "log":
      payload = await client.listCheckoutCommits(cwd);
      break;
    case "commit":
      payload = await client.checkoutCommit(cwd, {
        message: options.message,
        addAll: options.addAll !== false,
      });
      break;
    case "pull":
      payload = await client.checkoutPull(cwd);
      break;
    case "push":
      payload = await client.checkoutPush(cwd);
      break;
    case "refresh":
      requireFeature(client, "checkoutRefresh");
      payload = await client.checkoutRefresh(cwd);
      break;
    case "merge":
      if (options.fromBase)
        payload = await client.checkoutMergeFromBase(cwd, {
          baseRef: options.base,
          requireCleanTarget: true,
        });
      else
        payload = await client.checkoutMerge(cwd, {
          baseRef: options.base,
          strategy: options.strategy,
          requireCleanTarget: true,
        });
      break;
    case "discard":
      requireFeature(client, "checkoutDiscardChanges");
      payload = await client.checkoutDiscardChanges(cwd, { paths: args[0] as string[] });
      break;
    case "switch":
      payload = await client.checkoutSwitchBranch(cwd, String(args[0]));
      break;
    case "rename":
      payload = await client.renameBranch({ cwd, branch: String(args[0]) });
      break;
    case "stash-ls":
      payload = await client.stashList(cwd, { paseoOnly: options.paseoOnly === true });
      break;
    case "stash-save":
      payload = await client.stashSave(cwd, { branch: options.branch });
      break;
    case "stash-pop":
      payload = await client.stashPop(cwd, { index: Number(args[0]), hash: options.hash });
      break;
    default:
      throw new Error("Unknown Git operation: " + operation);
  }

  return payload;
}
