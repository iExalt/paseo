import path from "node:path";
import type { DesktopInstallation } from "../features/nix-managed-install.js";
import type { NodeEntrypointInvocation } from "./node-entrypoint-launcher.js";

/**
 * On Nix-managed macOS the app usually runs from the `/Applications/Paseo.app` copy, which the
 * next update replaces while the daemon may keep running. Launching the daemon from the
 * immutable store bundle that copy was built from means the swap neither waits for the daemon
 * nor changes files under it. Returns null when the daemon should launch from the running
 * bundle: not Nix-managed macOS, already in the store, or the store bundle is gone.
 */
export function daemonBundleRebase(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  installation: DesktopInstallation;
  resourcesPath: string;
  exists: (filePath: string) => boolean;
}): ((filePath: string) => string) | null {
  if (input.platform !== "darwin" || !input.isPackaged || input.installation.mode !== "nix") {
    return null;
  }
  const running = path.resolve(input.resourcesPath, "..", "..");
  const store = path.join(input.installation.outputPath, "Applications", "Paseo.app");
  if (running === store || !input.exists(store)) return null;
  return (filePath) =>
    filePath === running || filePath.startsWith(`${running}/`)
      ? `${store}${filePath.slice(running.length)}`
      : filePath;
}

/**
 * Whether the app should try to bring `/Applications/Paseo.app` up to the running release. Only
 * when the app itself runs from its store bundle, which means the last copy was deferred.
 */
export function shouldSyncInstalledCopy(resourcesPath: string): boolean {
  return resourcesPath.startsWith("/nix/store/");
}

/**
 * Rebases the executable and the code paths a daemon launch loads. `PASEO_CLI` keeps its
 * `/Applications` path: terminals and agent hooks hold it for their whole life, and the copy
 * always names the installed version, while a store path could be garbage-collected.
 */
export function rebaseDaemonLaunch(
  invocation: NodeEntrypointInvocation,
  rebase: (filePath: string) => string,
): NodeEntrypointInvocation {
  return { ...invocation, command: rebase(invocation.command), args: invocation.args.map(rebase) };
}
