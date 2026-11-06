import type { QueryClient } from "@tanstack/react-query";
import { listenToDesktopEvent } from "@/desktop/electron/events";

export const DAEMON_STATUS_QUERY_KEY = ["desktopDaemonStatus"] as const;
const subscriptions = new WeakMap<QueryClient, { count: number; dispose: Promise<() => void> }>();

/** One listener per query cache, shared by About and Host Overview consumers. */
export function retainDaemonStatusEvents(client: QueryClient): () => void {
  let subscription = subscriptions.get(client);
  if (!subscription) {
    subscription = {
      count: 0,
      dispose: listenToDesktopEvent("desktop-daemon-upgrade-changed", () => {
        void client.invalidateQueries({ queryKey: DAEMON_STATUS_QUERY_KEY });
      }).catch((error) => {
        console.error("[DesktopDaemon] Could not subscribe to upgrade status", error);
        return () => {};
      }),
    };
    subscriptions.set(client, subscription);
  }
  const retained = subscription;
  retained.count += 1;
  return () => {
    retained.count -= 1;
    if (retained.count === 0) {
      subscriptions.delete(client);
      void retained.dispose.then((dispose) => dispose());
    }
  };
}
