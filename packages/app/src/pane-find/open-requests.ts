import { useEffect } from "react";

/**
 * Opens a pane's find bar from outside the pane, such as a tab menu on touch devices
 * where there is no Cmd/Ctrl+F. Targets are `agent:<id>`, `file:<path>` or
 * `terminal:<id>`; the mounted pane for that target registers the handler.
 */
const handlers = new Map<string, () => void>();

export function requestPaneFind(target: string): boolean {
  const handler = handlers.get(target);
  handler?.();
  return handler !== undefined;
}

/** Whether a mounted pane can open find for the target now, so menus offer only working entries. */
export function canRequestPaneFind(target: string | null): boolean {
  return target !== null && handlers.has(target);
}

export function usePaneFindRequest(target: string | null, handler: () => void): void {
  useEffect(() => {
    if (!target) return undefined;
    handlers.set(target, handler);
    return () => {
      if (handlers.get(target) === handler) handlers.delete(target);
    };
  }, [target, handler]);
}
