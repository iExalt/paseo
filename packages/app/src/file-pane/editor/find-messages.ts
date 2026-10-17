import type { FileEditorFindOp, FileEditorHostMessage } from "./webview/protocol";

/**
 * The messages for one find action. The bar debounces the query, so an action taken
 * while typing first sends the query the user sees; the page applies messages in order.
 */
export function findOpMessages(
  op: FileEditorFindOp,
  query: string,
  sentQuery: string,
): FileEditorHostMessage[] {
  const acts = op !== "open" && op !== "close";
  return acts && query !== sentQuery
    ? [
        { type: "findQuery", query },
        { type: "find", op },
      ]
    : [{ type: "find", op }];
}

/**
 * Whether the bar's actions are enabled. A query the page has not searched yet may
 * match, and actions send it first, so a tap right after typing is not lost to the
 * previous query's count.
 */
export function findActionsEnabled(page: { query: string; total: number }, query: string): boolean {
  return page.total > 0 || (query !== "" && query !== page.query);
}
