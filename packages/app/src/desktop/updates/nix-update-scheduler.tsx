import { useEffect } from "react";
import { getDesktopHost } from "@/desktop/host";
import { checkForNixUpdate, NIX_UPDATE_CHECK_INTERVAL_MS } from "./nix-updates";

/** Checks for, and downloads, Nix-managed desktop updates at launch and hourly after. */
export function NixUpdateScheduler() {
  useEffect(() => {
    if (getDesktopHost()?.installationMode !== "nix") return;
    void checkForNixUpdate({ userInitiated: false });
    const interval = setInterval(
      () => void checkForNixUpdate({ userInitiated: false }),
      NIX_UPDATE_CHECK_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, []);
  return null;
}
