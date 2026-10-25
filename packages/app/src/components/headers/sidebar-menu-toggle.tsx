import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PanelLeft } from "lucide-react-native";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HeaderToggleButton, headerIconSlotStyle } from "./header-toggle-button";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { resolveMenuPressOutcome } from "@/components/desktop-sidebar-layout";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { hideExplorerSidebar, isExplorerSidebarOpen } from "@/workspace-tabs/explorer-sidebar";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useHasWindowChromeObstruction, useOwnsWindowChromeCorner } from "@/utils/desktop-window";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";

const ThemedPanelLeft = withUnistyles(PanelLeft);

interface SidebarMenuToggleProps {
  style?: StyleProp<ViewStyle>;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  testID?: string;
  nativeID?: string;
}

const NO_SHORTCUT: ShortcutKey[] = [];

const MOBILE_MENU_LINE_WIDTH = 16;
const MOBILE_MENU_LINE_SHORT_WIDTH = 8;
const MOBILE_MENU_LINE_HEIGHT = 1.5;

function MobileMenuIcon({ extraMuted }: { extraMuted: boolean }) {
  const color = extraMuted ? styles.mobileMenuLineExtraMuted : styles.mobileMenuLineMuted;
  const lineStyle = useMemo(() => [styles.mobileMenuLine, color], [color]);
  const shortLineStyle = useMemo(
    () => [styles.mobileMenuLine, styles.mobileMenuLineShort, color],
    [color],
  );
  return (
    <View style={styles.mobileMenuIcon} pointerEvents="none">
      <View style={lineStyle} />
      <View style={lineStyle} />
      <View style={shortLineStyle} />
    </View>
  );
}

/**
 * Shared by the menu button and the toggle-sidebar shortcut: the last press
 * wins, so an open Explorer that leaves the sidebar no room yields to it.
 */
export function useSidebarMenuPress(isCompact: boolean): () => void {
  const toggleAgentListForLayout = usePanelStore((state) => state.toggleAgentListForLayout);
  const openAgentListForLayout = usePanelStore((state) => state.openAgentListForLayout);
  const isWorkspaceRoute = parseHostWorkspaceRouteFromPathname(usePathname()) !== null;
  const activeWorkspace = useActiveWorkspaceSelection();
  const workspaceKey = activeWorkspace
    ? `${activeWorkspace.serverId}:${activeWorkspace.workspaceId}`
    : null;
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;

  return useCallback(() => {
    const explorerQuery = { isCompact: false, workspaceKey };
    const outcome = resolveMenuPressOutcome({
      isCompactLayout: isCompact,
      explorerOpen: isWorkspaceRoute && isExplorerSidebarOpen(explorerQuery),
      requestedSidebarWidth: usePanelStore.getState().sidebarWidth,
      viewportWidth,
    });
    if (outcome === "show-sidebar-over-explorer") {
      hideExplorerSidebar(explorerQuery);
      openAgentListForLayout({ isCompact: false });
      return;
    }
    toggleAgentListForLayout({ isCompact });
  }, [
    toggleAgentListForLayout,
    openAgentListForLayout,
    isCompact,
    isWorkspaceRoute,
    workspaceKey,
    viewportWidth,
  ]);
}

function SidebarMenuToggleButton({
  isMobile,
  extraMutedIdleIcon = false,
  resolvedStyle,
  tooltipSide = "right",
  testID = "menu-button",
  nativeID = "menu-button",
}: Omit<SidebarMenuToggleProps, "style"> & {
  isMobile: boolean;
  extraMutedIdleIcon?: boolean;
  resolvedStyle: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const isOpen = usePanelStore((state) => selectIsAgentListOpen(state, { isCompact: isMobile }));
  const toggleShortcutChord = useShortcutKeys("toggle-left-sidebar");

  const handlePress = useSidebarMenuPress(isMobile);

  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);

  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("shell.menu.toggleSidebar")}
      tooltipKeys={NO_SHORTCUT}
      tooltipChord={toggleShortcutChord}
      tooltipSide={tooltipSide}
      testID={testID}
      nativeID={nativeID}
      style={resolvedStyle}
      accessible
      accessibilityRole="button"
      accessibilityLabel={isOpen ? t("shell.menu.close") : t("shell.menu.open")}
      accessibilityState={accessibilityState}
    >
      {isMobile ? (
        <MobileMenuIcon extraMuted={extraMutedIdleIcon} />
      ) : (
        <ThemedPanelLeft
          size={iconButtonChromeGlyphSize("large")}
          strokeWidth={1.5}
          uniProps={extraMutedIdleIcon ? extraMutedIconColorMapping : mutedIconColorMapping}
        />
      )}
    </HeaderToggleButton>
  );
}

export function SidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const isMobile = useIsCompactFormFactor();
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  const placeholderStyle = useMemo(
    () => [headerIconSlotStyle.slot, resolvedStyle],
    [resolvedStyle],
  );

  if (!isMobile && !ownsTopLeft) {
    return null;
  }

  if (!isMobile && hasTopLeftWindowControls) {
    return (
      <View pointerEvents="none" style={placeholderStyle}>
        <View style={styles.desktopMenuIconSpace} />
      </View>
    );
  }

  return <SidebarMenuToggleButton {...props} isMobile={isMobile} resolvedStyle={resolvedStyle} />;
}

export function WindowSidebarMenuToggle({ style, ...props }: SidebarMenuToggleProps = {}) {
  const resolvedStyle = useMemo(() => [styles.leadingToggle, style], [style]);
  return (
    <SidebarMenuToggleButton
      {...props}
      isMobile={false}
      extraMutedIdleIcon
      resolvedStyle={resolvedStyle}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  leadingToggle: {
    marginLeft: {
      xs: 0,
      md: -theme.spacing[2],
    },
  },
  mobileMenuIcon: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: 12,
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  desktopMenuIconSpace: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
  },
  mobileMenuLine: {
    width: MOBILE_MENU_LINE_WIDTH,
    height: MOBILE_MENU_LINE_HEIGHT,
    borderRadius: theme.borderRadius.full,
  },
  mobileMenuLineMuted: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  mobileMenuLineExtraMuted: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  mobileMenuLineShort: {
    width: MOBILE_MENU_LINE_SHORT_WIDTH,
  },
}));
