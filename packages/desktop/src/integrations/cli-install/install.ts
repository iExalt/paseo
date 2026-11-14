import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import log from "electron-log/main";
import { resolveCliInstallSourcePath } from "./path.js";
import { getBundledCliShimPath, getCliTargetPath, getLocalBinDir } from "./paths.js";
import { ensurePathInShellRc } from "./shell-rc.js";
import {
  resolveDesktopInstallation,
  resolveLinuxDesktopInstallation,
} from "../../features/nix-managed-install.js";
import { cliIsInstalled, installLinuxNixCli } from "./install-files.js";

interface InstallStatus {
  installed: boolean;
}

async function pathOrSymlinkExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function installCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  const shimPath = getBundledCliShimPath();
  const installSourcePath = resolveCliInstallSourcePath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    shimPath,
    appImagePath: process.env.APPIMAGE,
  });
  const binDir = getLocalBinDir();
  const installation =
    process.platform === "linux" ? resolveDesktopInstallation(process.resourcesPath) : null;
  if (installation?.mode === "nix") {
    const stateRoot = path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
      "paseo",
      "nix-update",
    );
    if (!path.isAbsolute(stateRoot)) throw new Error("XDG state path must be absolute.");
    const profile = path.join(stateRoot, "profile");
    await installLinuxNixCli({
      installation,
      activeInstallation: resolveLinuxDesktopInstallation(
        path.join(profile, "share", "paseo-desktop", "electron-app"),
      ),
      profile,
      target: targetPath,
    });
  } else {
    await fs.mkdir(binDir, { recursive: true });

    if (process.platform === "win32") {
      if (await pathOrSymlinkExists(targetPath)) {
        await fs.unlink(targetPath);
      }
      // Generate a thin .cmd trampoline that delegates to the bundled shim.
      // Only the app install path is baked in — internal details (asar layout,
      // entrypoint scripts) live in the bundled shim and update with the app.
      const cmdContent = [
        "@echo off",
        `set "BUNDLED_CLI=${shimPath}"`,
        `if not exist "%BUNDLED_CLI%" (`,
        `  echo Paseo CLI not found at %BUNDLED_CLI% — is Paseo installed? 1>&2`,
        `  exit /b 1`,
        `)`,
        `call "%BUNDLED_CLI%" %*`,
        `exit /b %errorlevel%`,
      ].join("\r\n");
      await fs.writeFile(targetPath, cmdContent, "utf-8");
    } else {
      if (await pathOrSymlinkExists(targetPath)) {
        await fs.unlink(targetPath);
      }
      await fs.symlink(installSourcePath, targetPath);
    }
  }
  const { shellUpdated } = await ensurePathInShellRc();
  if (shellUpdated) {
    log.info("[integrations] Updated shell rc with ~/.local/bin PATH");
  }

  return getCliInstallStatus();
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return { installed: await cliIsInstalled(targetPath, process.platform) };
}
