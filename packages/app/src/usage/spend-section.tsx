import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SpendSummary } from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { type ProviderIconComponent, useProviderIcons } from "@/components/provider-icons";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { usageCopy } from "./copy";
import { formatAmount } from "./format";
import { useHostSpend } from "./spend";
import { UsageMessage } from "./usage-section";

type ProviderSpend = SpendSummary["providers"][number];

function ProviderGlyph({
  icon: Icon,
  size,
  color = "",
}: {
  icon: ProviderIconComponent;
  size: number;
  color?: string;
}) {
  return <Icon size={size} color={color} />;
}

const ThemedProviderGlyph = withUnistyles(ProviderGlyph);
const mutedIconColor = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

/** The info tip: what the numbers are, since when, and how much predates tracking. */
export function spendInfo(summary: SpendSummary | null, locale: string): string {
  const parts: string[] = [usageCopy.spendInfo];
  if (summary?.trackingSince) {
    const since = new Date(summary.trackingSince).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    parts.push(usageCopy.spendTrackingSince(since));
  }
  const carried = summary?.providers.reduce((sum, provider) => sum + provider.carriedUsd, 0) ?? 0;
  if (carried > 0) parts.push(usageCopy.spendCarried(formatAmount(carried, "usd", locale)));
  return parts.join(" ");
}

/** A host's API spend by provider, for its settings page and the Usage modal. */
export function HostSpendSection({ serverId, flush }: { serverId: string; flush?: boolean }) {
  const { i18n } = useTranslation();
  const view = useHostSpend(serverId);
  const summary = view.kind === "ready" ? view.summary : null;
  return (
    <SettingsSection
      title={usageCopy.spend}
      info={spendInfo(summary, i18n.language)}
      testID="spend-card"
      flush={flush}
    >
      <SpendBody serverId={serverId} view={view} locale={i18n.language} />
    </SettingsSection>
  );
}

function SpendBody({
  serverId,
  view,
  locale,
}: {
  serverId: string;
  view: ReturnType<typeof useHostSpend>;
  locale: string;
}) {
  if (view.kind === "unavailable") return <UsageMessage text={view.message} />;
  if (view.kind === "loading") return <UsageMessage text={usageCopy.spendLoading} />;
  if (view.kind === "error") {
    return (
      <Alert
        size="sm"
        variant="error"
        title={usageCopy.spendErrorTitle}
        description={view.message}
      />
    );
  }
  if (view.summary.providers.length === 0) return <UsageMessage text={usageCopy.spendEmpty} />;
  return (
    <View style={settingsStyles.card}>
      {view.summary.providers.map((provider, index) => (
        <ProviderSpendRow
          key={provider.provider}
          serverId={serverId}
          spend={provider}
          locale={locale}
          bordered={index > 0}
        />
      ))}
    </View>
  );
}

function ProviderSpendRow({
  serverId,
  spend,
  locale,
  bordered,
}: {
  serverId: string;
  spend: ProviderSpend;
  locale: string;
  bordered: boolean;
}) {
  const { entries } = useProvidersSnapshot(serverId);
  const getProviderIcon = useProviderIcons(serverId);
  const label = resolveProviderLabel(spend.provider, entries);
  const usd = (value: number) => formatAmount(value, "usd", locale);
  return (
    <View
      style={bordered ? [styles.row, settingsStyles.rowBorder] : styles.row}
      testID={`spend-row-${spend.provider}`}
    >
      <View style={styles.header}>
        <View style={styles.provider}>
          <ThemedProviderGlyph
            icon={getProviderIcon(spend.provider)}
            size={14}
            uniProps={mutedIconColor}
          />
          <Text style={styles.providerLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
        <View
          style={styles.total}
          accessible
          accessibilityLabel={`${usageCopy.spendAllTime} ${usd(spend.allTimeUsd)}`}
        >
          <Text style={styles.periodLabel}>{usageCopy.spendAllTime}</Text>
          <Text style={styles.totalValue}>{usd(spend.allTimeUsd)}</Text>
        </View>
      </View>
      <View style={styles.periods}>
        <SpendPeriod label={usageCopy.spendToday} value={usd(spend.todayUsd)} />
        <SpendPeriod label={usageCopy.spendLast7Days} value={usd(spend.last7DaysUsd)} />
        <SpendPeriod label={usageCopy.spendThisMonth} value={usd(spend.thisMonthUsd)} />
      </View>
    </View>
  );
}

function SpendPeriod({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.period} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.periodLabel}>{label}</Text>
      <Text style={styles.periodValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  provider: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  providerLabel: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  total: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  totalValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  periods: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  period: {
    flex: 1,
    gap: 2,
  },
  periodLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  periodValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
