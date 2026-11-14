import { connectToDaemon } from "../../utils/client.js";
import { checkoutResult, requireFeature, resolveCheckoutCwd, type GitOptions } from "../git/run.js";
export interface PrOptions extends GitOptions {
  title?: string;
  body?: string;
  method?: "merge" | "squash" | "rebase";
  disable?: boolean;
  checkRunId?: string;
  workflowRunId?: string;
  number?: string;
  repoOwner?: string;
  repoName?: string;
}
function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw { code: "INVALID_OPTIONS", message: "IDs and PR numbers must be positive integers" };
  return number;
}
export async function runPrCommand(
  operation: string,
  options: PrOptions,
  connect: typeof connectToDaemon = connectToDaemon,
) {
  if (["merge", "auto-merge"].includes(operation) && !options.force)
    throw { code: "CONFIRMATION_REQUIRED", message: "Pass --force to confirm " + operation };
  const checkRunId = positiveInteger(options.checkRunId);
  const workflowRunId = positiveInteger(options.workflowRunId);
  const number = positiveInteger(options.number);
  if (operation === "check" && checkRunId === undefined && workflowRunId === undefined)
    throw { code: "INVALID_OPTIONS", message: "Pass --check-run-id or --workflow-run-id" };
  const client = await connect({ target: options.daemonTarget });
  try {
    const cwd = await resolveCheckoutCwd(client, options);
    let payload: object;
    switch (operation) {
      case "status":
      case "checks":
        payload = await client.checkoutPrStatus(cwd);
        break;
      case "check":
        requireFeature(client, "forgeCheckDetails");
        payload = await loadCheckDetails(client, cwd, options, {
          checkRunId,
          workflowRunId,
          changeRequestNumber: number,
        });
        break;
      case "timeline":
        payload = await loadTimeline(client, cwd, options, number);
        break;
      case "create":
        payload = await client.checkoutPrCreate(cwd, {
          title: options.title,
          body: options.body,
          baseRef: options.base,
        });
        break;
      case "merge":
        payload = await client.checkoutPrMerge(cwd, { method: options.method ?? "squash" });
        break;
      case "auto-merge":
        requireFeature(client, "checkoutForgeSetAutoMerge");
        payload = await client.checkoutForgeSetAutoMerge(
          cwd,
          options.disable
            ? { enabled: false }
            : { enabled: true, method: options.method ?? "squash" },
        );
        break;
      default:
        throw new Error("Unknown PR operation: " + operation);
    }
    return checkoutResult({ ...payload, cwd, operation });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function loadTimeline(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  cwd: string,
  options: PrOptions,
  number: number | undefined,
): Promise<object> {
  const current = await client.checkoutPrStatus(cwd);
  checkoutResult(current);
  const prNumber = number ?? current.status?.number;
  const repoOwner = options.repoOwner ?? current.status?.repoOwner;
  const repoName = options.repoName ?? current.status?.repoName;
  if (!prNumber || !repoOwner || !repoName)
    throw {
      code: "PR_NOT_FOUND",
      message: "No current PR identity; pass --number, --repo-owner and --repo-name",
    };
  const timeline = await client.pullRequestTimeline({ cwd, prNumber, repoOwner, repoName });
  if (!timeline) throw { code: "PR_TIMELINE_FAILED", message: "Host returned no timeline" };
  return timeline;
}

async function loadCheckDetails(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  cwd: string,
  options: PrOptions,
  ids: {
    checkRunId: number | undefined;
    workflowRunId: number | undefined;
    changeRequestNumber: number | undefined;
  },
): Promise<object> {
  const current = await client.checkoutPrStatus(cwd);
  checkoutResult(current);
  const owner = options.repoOwner ?? current.status?.repoOwner;
  const name = options.repoName ?? current.status?.repoName;
  const segment = /^[A-Za-z0-9_.-]+$/;
  const repository =
    owner && name && segment.test(owner) && segment.test(name)
      ? { repoOwner: owner, repoName: name }
      : {};
  const payload = await client.checkoutForgeGetCheckDetails({
    cwd,
    ...ids,
    changeRequestNumber: ids.changeRequestNumber ?? current.status?.number,
    ...repository,
  });
  if (!payload) throw { code: "PR_CHECK_FAILED", message: "Host returned no check details" };
  return payload;
}
