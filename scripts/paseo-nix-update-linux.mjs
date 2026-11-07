import assert from "node:assert/strict";
import { lstat, mkdir, readFile, link, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
export function linuxUpdatePaths({ home = homedir(), env = process.env } = {}) {
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  assert.ok(isAbsolute(state) && isAbsolute(data), "XDG state and data paths must be absolute");
  return {
    root: join(state, "paseo", "nix-update"),
    launcher: join(home, ".local", "bin", "paseo-desktop"),
    desktop: join(data, "applications", "paseo-desktop.desktop"),
  };
}
export function linuxLauncherFiles(profile, paths = linuxUpdatePaths()) {
  assert.ok(isAbsolute(profile) && !/[\r\n]/.test(profile), "Invalid dedicated profile path");
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const desktopQuote = (value) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("%", "%%")}"`;
  return [
    {
      file: paths.launcher,
      mode: 0o755,
      text: `#!/bin/sh\n# Owned by Paseo fork updates.\nexec ${shellQuote(join(profile, "bin", "paseo-desktop"))} "$@"\n`,
    },
    {
      file: paths.desktop,
      mode: 0o644,
      text: `[Desktop Entry]\n# Owned by Paseo fork updates.\nType=Application\nName=Paseo\nExec=${desktopQuote(paths.launcher)} %U\nIcon=paseo-desktop\nTerminal=false\nCategories=Development;\nStartupWMClass=paseo-desktop\n`,
    },
  ];
}
export async function assertLinuxLauncherOwnership(profile, paths = linuxUpdatePaths()) {
  for (const entry of linuxLauncherFiles(profile, paths)) {
    try {
      const info = await lstat(entry.file);
      assert.ok(
        info.isFile() && !info.isSymbolicLink(),
        "Existing Linux launcher is externally managed; keep it and explicitly choose the dedicated Paseo launcher",
      );
      assert.equal(
        await readFile(entry.file, "utf8"),
        entry.text,
        "Existing Linux launcher belongs to another installation; no files were replaced",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export async function removeCreatedLinuxLaunchers(created) {
  for (const entry of created) {
    try {
      const info = await lstat(entry.file);
      if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        (await readFile(entry.file, "utf8")) === entry.text
      )
        await rm(entry.file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export async function syncLinuxLauncher(profile, paths = linuxUpdatePaths()) {
  await assertLinuxLauncherOwnership(profile, paths);
  const created = [];
  try {
    for (const entry of linuxLauncherFiles(profile, paths)) {
      await mkdir(dirname(entry.file), { recursive: true });
      try {
        await lstat(entry.file);
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temporary = `${entry.file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, entry.text, { mode: entry.mode, flag: "wx" });
        await link(temporary, entry.file);
        created.push(entry);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return created;
  } catch (error) {
    await removeCreatedLinuxLaunchers(created);
    throw error;
  }
}
export function validateLinuxNixPrerequisites(storeInfo, configuration, releaseKey) {
  assert.ok(
    storeInfo && typeof storeInfo.trusted === "boolean",
    "Cannot determine effective Nix store permissions",
  );
  if (!storeInfo.trusted)
    assert.ok(
      configuration["trusted-public-keys"]?.value?.includes(releaseKey),
      `The Nix daemon must trust the Paseo release key before updates can import closures: ${releaseKey}. Ask its administrator to add this public key; Paseo will not change system configuration.`,
    );
}
/** Explicit initial adoption uses the running tag, never a newer Latest release. */
export async function executeLinuxBootstrap(adapters) {
  await adapters.assertOwnership();
  await adapters.preflight();
  const release = await adapters.runningRelease();
  assert.equal(
    adapters.artifact(release.manifest).outputPath,
    adapters.runningOutput,
    "Signed release output differs from the running Linux installation",
  );
  await adapters.stage(release);
  const created = await adapters.prepareLauncher();
  try {
    return await adapters.activate();
  } catch (error) {
    await adapters.rollbackLauncher(created);
    throw error;
  }
}
