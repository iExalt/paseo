import { getDesktopHost } from "@/desktop/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export const BROWSER_DATA_DESCRIPTION_KEY = "settings.general.browserData.description";

/** Clears the Electron browser profile, then the desktop host reloads open tabs. */
export async function clearBrowserData(browserIds: string[]): Promise<void> {
  const clearProfile = getDesktopHost()?.browser?.clearProfile;
  if (!clearProfile) {
    throw new Error("Electron browser profile bridge is unavailable");
  }
  const hostIds = getHostRuntimeStore()
    .getHosts()
    .map((host) => host.serverId);
  await clearProfile(browserIds, hostIds);
}
