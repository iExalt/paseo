import type { DesktopDaemonStatus, DesktopDaemonUpgrade } from "./desktop-daemon";

/** A host keeps its identity while its daemon is replaced; other hosts never inherit it. */
export function daemonUpgradeForHost(
  status: DesktopDaemonStatus | null,
  serverId: string,
  managementEnabled = true,
): DesktopDaemonUpgrade | null {
  const upgrade = status?.upgrade;
  if (!managementEnabled || !upgrade || upgrade.serverId !== serverId) return null;
  if (status.serverId && status.serverId !== serverId) return null;
  if (status.status === "running" || status.status === "starting") {
    if (
      !status.desktopManaged ||
      status.pid !== upgrade.pid ||
      status.startedAt !== upgrade.startedAt
    )
      return null;
  } else if (upgrade.phase !== "upgrading" && upgrade.phase !== "failed") return null;
  return upgrade;
}

export function desktopDaemonServerId(status: DesktopDaemonStatus): string | null {
  const liveId = status.serverId.trim();
  if (liveId) return liveId;
  const upgradeId = status.upgrade?.serverId;
  return upgradeId && daemonUpgradeForHost(status, upgradeId) ? upgradeId : null;
}
