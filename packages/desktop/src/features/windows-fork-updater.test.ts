import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ForkNsisUpdater,
  configureForkWindowsUpdater,
  installedForkFloor,
  verifyForkInstaller,
} from "./windows-fork-updater.js";
import type { DesktopReleaseManifest } from "@getpaseo/protocol/desktop-release-manifest";
import type { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
const bytes = Buffer.from("fixture NSIS installer");
const artifact = {
  platform: "windows" as const,
  arch: "x64" as const,
  kind: "nsis" as const,
  name: "paseo-1.2.4-windows-x64.exe",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sha512: createHash("sha512").update(bytes).digest("base64"),
};
const release = {
  version: "1.2.4",
  releaseTag: "paseo-v1.2.4",
  artifacts: [artifact],
} as DesktopReleaseManifest;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fork-nsis-"));
  directories.push(directory);
  const config = path.join(directory, "app-update.yml");
  await writeFile(config, "updaterCacheDirName: fixture-updater\n");
  const quit = vi.fn();
  const updater = new ForkNsisUpdater(undefined, {
    version: "1.2.3",
    name: "Paseo",
    isPackaged: true,
    userDataPath: directory,
    baseCachePath: directory,
    appUpdateConfigPath: config,
    whenReady: async () => {},
    quit,
    relaunch: vi.fn(),
    onQuit: vi.fn(),
  });
  updater.logger = null;
  const download = vi.fn(async (_url: URL, file: string) => {
    await writeFile(file, bytes);
  });
  updater.httpExecutor = { download } as unknown as ElectronHttpExecutor;
  let selected = release;
  const latest = vi.fn(async () => selected);
  const prepare = configureForkWindowsUpdater(updater, {
    platform: "win32",
    arch: "x64",
    stateDirectory: directory,
    runningVersion: "1.2.3",
    latest,
  });
  return {
    directory,
    updater,
    download,
    latest,
    prepare,
    quit,
    select: (manifest: DesktopReleaseManifest) => {
      selected = manifest;
    },
  };
}
describe("actual NSIS fork provider and download orchestration", () => {
  it("uses the custom signed provider, full-download path and revalidates even in-memory cached bytes", async () => {
    const f = await fixture();
    const checked = await f.updater.checkForUpdates();
    expect(checked?.isUpdateAvailable).toBe(true);
    const files = await checked?.downloadPromise;
    expect(files?.length).toBe(1);
    expect(f.download).toHaveBeenCalledOnce();
    expect(f.download.mock.calls[0][0].href).toContain(
      "/iExalt/paseo/releases/download/paseo-v1.2.4/paseo-1.2.4-windows-x64.exe",
    );
    await f.prepare("1.2.4");
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
    expect(f.updater.disableDifferentialDownload).toBe(true);
    await writeFile(files![0], Buffer.alloc(bytes.length));
    await expect(f.prepare("1.2.4")).rejects.toThrow("digest");
    expect(f.quit).not.toHaveBeenCalled();
  });
  it("refuses superseded releases and interrupted downloads, then retries the same target", async () => {
    const f = await fixture();
    f.download.mockRejectedValueOnce(new Error("interrupted"));
    const checked = await f.updater.checkForUpdates();
    await expect(checked?.downloadPromise).rejects.toThrow("interrupted");
    await f.updater.downloadUpdate();
    await f.prepare("1.2.4");
    f.select({ ...release, version: "1.2.5", releaseTag: "paseo-v1.2.5" });
    await expect(f.prepare("1.2.4")).rejects.toThrow("changed");
    expect(await readFile(path.join(f.directory, "fork-installed-version.json"), "utf8")).toBe(
      '"1.2.3"',
    );
  });
  it("seeds ordering from the running version, preserves a newer installed floor and rejects malformed state", async () => {
    const f = await fixture();
    const file = path.join(f.directory, "floor.json");
    expect(await installedForkFloor(file, "1.2.5")).toBe("1.2.5");
    expect(await installedForkFloor(file, "1.2.3")).toBe("1.2.5");
    f.select({ ...release, version: "1.2.2" });
    await expect(f.updater.checkForUpdates()).rejects.toThrow("older");
    expect(() =>
      configureForkWindowsUpdater(f.updater, {
        platform: "win32",
        arch: "arm64",
        stateDirectory: f.directory,
        runningVersion: "1.2.3",
      }),
    ).toThrow("Windows x64");
    await writeFile(file, '"beta"');
    await expect(installedForkFloor(file, "1.2.5")).rejects.toThrow();
    const bad = path.join(f.directory, "bad.exe");
    await writeFile(bad, "bad");
    await expect(verifyForkInstaller(bad, artifact)).rejects.toThrow("size");
  });
});
