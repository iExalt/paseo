import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { DesktopInstallation } from "../../features/nix-managed-install.js";

export async function cliIsInstalled(target: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await fs.stat(target)).isFile()) return false;
    await fs.access(target, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Inputs come from the running and active installation resolvers; all file operations are real. */
export async function installLinuxNixCli(input: {
  installation: Extract<DesktopInstallation, { mode: "nix" }>;
  activeInstallation: DesktopInstallation;
  profile: string;
  target: string;
}): Promise<void> {
  const { profile, target, activeInstallation } = input;
  const shim = path.join(
    input.installation.outputPath,
    "share",
    "paseo-desktop",
    "packages",
    "cli",
    "bin",
    "paseo",
  );
  const stable = path.join(profile, "share", "paseo-desktop", "packages", "cli", "bin", "paseo");
  let source = shim;
  let previous: string | null = null;
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) previous = await fs.readlink(target);
    if (!info.isSymbolicLink() || ![shim, stable].includes(previous ?? ""))
      throw new Error("The existing CLI belongs to another installation; no files were replaced.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous === stable) return;
  try {
    const state = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(profile), "semver-v1", "profile-state.json"),
        "utf8",
      ),
    );
    if (
      activeInstallation.mode === "nix" &&
      state.current?.outputPath === activeInstallation.outputPath &&
      (await fs.realpath(profile)) === activeInstallation.outputPath
    ) {
      await fs.access(stable, constants.X_OK);
      source = stable;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.symlink(source, temporary);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
