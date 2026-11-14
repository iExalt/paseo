export interface SafeAreaInsetsLike {
  top: number;
  bottom: number;
}

// The desktop split sidebar owns its full height, so it must clear both the top and bottom
// system insets (e.g. a tablet taskbar). The compact layout is padded by its parent.
export function getSettingsSidebarInnerStyle(isDesktop: boolean, insets: SafeAreaInsetsLike) {
  return [{ flex: 1 }, isDesktop ? { paddingTop: insets.top, paddingBottom: insets.bottom } : null];
}
