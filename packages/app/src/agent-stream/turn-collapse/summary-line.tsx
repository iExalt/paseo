import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Summary } from "lucide-react-native";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { TurnSummaryItem } from "@/types/stream";

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it.
 */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  item,
  onExpandedChange,
}: {
  item: TurnSummaryItem;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const messageCount =
    "messageCount" in item && typeof item.messageCount === "number" ? item.messageCount : 0;
  // Messages lead the label: a folded message may hold text the reader needs.
  const messageParts = useMemo(
    () =>
      messageCount > 0
        ? [
            t(`turnSummary.messages.${messageCount === 1 ? "one" : "other"}`, {
              count: messageCount,
            }),
          ]
        : [],
    [messageCount, t],
  );
  const label = useOverviewSummaryLabel(item.tools, messageParts) || t("turnSummary.details");
  const hold = useDisclosureHold();
  const toggle = useCallback(
    () => hold(() => onExpandedChange(item.hostId, !item.expanded)),
    [hold, onExpandedChange, item.expanded, item.hostId],
  );

  return (
    <ExpandableBadge
      testID="turn-summary"
      label={label}
      icon={Summary}
      isExpanded={item.expanded}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});
