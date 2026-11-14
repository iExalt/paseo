import { useMemo, useRef } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import type { PendingPermission } from "@/types/shared";
import {
  projectNotificationPreview,
  retainNotificationOpenIntent,
  useNotificationReceipt,
  type NotificationOpenIntent,
} from "./preview";
import type { BottomAnchorRouteRequest } from "@/agent-stream/bottom-anchor-controller";

const EMPTY_HEAD: StreamItem[] = [];

export function useNotificationPresentation(input: {
  serverId: string;
  agentId: string;
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  authoritative: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  readOnly: boolean;
  routeRequest: BottomAnchorRouteRequest | null;
}) {
  const receipt = useNotificationReceipt((state) =>
    state.receipt?.serverId === input.serverId && state.receipt.agentId === input.agentId
      ? state.receipt
      : null,
  );
  const latestIntent = useNotificationReceipt((state) => state.openIntent);
  const cachedIntent = useRef<NotificationOpenIntent | null>(null);
  cachedIntent.current = retainNotificationOpenIntent(
    cachedIntent.current,
    latestIntent,
    input.serverId,
    input.agentId,
  );
  const intent = cachedIntent.current;
  const entryRequest = useMemo<BottomAnchorRouteRequest | null>(
    () =>
      intent
        ? {
            reason: "notification-entry",
            agentId: intent.agentId,
            requestKey: `notification:${intent.serverId}:${intent.agentId}:${intent.tapId}`,
          }
        : null,
    [intent],
  );
  const range = useSessionStore(
    (state) => state.sessions[input.serverId]?.agentTimelineCursor.get(input.agentId) ?? null,
  );
  const { tail, head, authoritative, pendingPermissions, readOnly, routeRequest } = input;
  return useMemo(() => {
    const presentation = projectNotificationPreview({
      tail,
      head: head ?? EMPTY_HEAD,
      receipt,
      range,
      authoritative,
      pendingPermissionIds: Array.from(pendingPermissions.values(), (entry) => entry.request.id),
    });
    return {
      ...presentation,
      receipt,
      anchorRequest: entryRequest ?? routeRequest,
      // Presentation readiness is solely for viewport anchoring, never timeline coverage.
      isContentReady: authoritative || presentation.previewId !== null,
      readOnly: readOnly || presentation.previewId !== null,
    };
  }, [
    tail,
    head,
    authoritative,
    pendingPermissions,
    readOnly,
    receipt,
    range,
    entryRequest,
    routeRequest,
  ]);
}
