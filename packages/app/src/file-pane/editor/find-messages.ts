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
