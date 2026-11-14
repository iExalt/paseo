import { getIsElectron, isNative } from "@/constants/platform";

/**
 * Browser tabs need a real web view: Electron's <webview> or the native WebView.
 * A plain browser cannot embed arbitrary sites, so web keeps them unavailable.
 */
export function resolveBrowserTabsAvailable(runtime: {
  isElectron: boolean;
  isNative: boolean;
}): boolean {
  return runtime.isElectron || runtime.isNative;
}

export function getBrowserTabsAvailable(): boolean {
  return resolveBrowserTabsAvailable({ isElectron: getIsElectron(), isNative });
}
