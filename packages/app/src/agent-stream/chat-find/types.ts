import type { ReactNode, RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";

export interface MountedMessageIds {
  has(messageId: string): boolean;
}
export interface ChatFindProps {
  agentId: string;
  serverId: string;
  epoch: string | null;
  items: StreamItem[];
  /** The rows the stream draws: user text as shown, assistant messages one row per block. */
  rows: readonly StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedMessage(messageId: string): boolean;
  visibleMessageIds: MountedMessageIds;
  children: ReactNode;
}
export interface ChatFindExpansionProps {
  messageId: string;
  children(renderFullContent: boolean): ReactNode;
}
