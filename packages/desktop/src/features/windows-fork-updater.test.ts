import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { generateKeyPairSync, sign } from "node:crypto";
import { forkReleaseManifestV3Fixture } from "../../../../scripts/test-fixtures/fork-release-manifest";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  ForkNsisUpdater,
  latestWindowsRelease,
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
  class InstallerProbe extends ForkNsisUpdater {
    readonly launches = vi.fn(async (_command: string, _args: string[]) => true);
    protected override spawnLog(command: string, args: string[] = []) {
      return this.launches(command, args);
    }
  }
  const updater = new InstallerProbe(undefined, {
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
  it("does not quit on a failed installer spawn and allows retry with the NSIS relaunch arguments", async () => {
    const f = await fixture();
    await expect(f.updater.launchForkInstaller(false, true)).rejects.toThrow("unavailable");
    const checked = await f.updater.checkForUpdates();
    await checked?.downloadPromise;
    f.updater.installDirectory = path.join(f.directory, "Paseo install");
    f.updater.launches.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(f.updater.launchForkInstaller(false, true)).rejects.toThrow("spawn failed");
    expect(f.quit).not.toHaveBeenCalled();
    await f.updater.launchForkInstaller(false, true);
    expect(f.updater.launches).toHaveBeenLastCalledWith(f.updater.forkInstallerPath, [
      "--updated",
      "--force-run",
      `/D=${f.updater.installDirectory}`,
    ]);
    await expect(f.updater.launchForkInstaller(false, true)).rejects.toThrow("already in progress");
  });
  it("awaits elevation failure before allowing a silent installer retry", async () => {
    const f = await fixture();
    const checked = await f.updater.checkForUpdates();
    await checked?.downloadPromise;
    vi.stubGlobal("process", { ...process, resourcesPath: f.directory });
    try {
      f.updater.launches
        .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
        .mockRejectedValueOnce(new Error("elevation failed"));
      await expect(f.updater.launchForkInstaller(true, false)).rejects.toThrow("elevation failed");
      expect(f.updater.launches).toHaveBeenLastCalledWith(path.join(f.directory, "elevate.exe"), [
        f.updater.forkInstallerPath,
        "--updated",
        "/S",
      ]);
      expect(f.quit).not.toHaveBeenCalled();
      await expect(f.updater.launchForkInstaller(true, false)).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("loads the compiled CommonJS updater with the real electron-updater exports", () => {
    const desktopDirectory = path.resolve(import.meta.dirname, "../..");
    const config = ts.readConfigFile(path.join(desktopDirectory, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, desktopDirectory);
    const fileName = path.join(import.meta.dirname, "windows-fork-updater.ts");
    const compiled = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: parsed.options,
    });
    // Vitest's import interop differs from the CommonJS code shipped by tsc.
    expect(
      execFileSync(
        process.execPath,
        ["-e", `${compiled.outputText}\nconsole.log(typeof exports.ForkNsisUpdater);`],
        {
          cwd: desktopDirectory,
          encoding: "utf8",
          timeout: 10_000,
        },
      ).trim(),
    ).toBe("function");
  });
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
    const retry = await f.updater.checkForUpdates();
    await retry?.downloadPromise;
    await expect(f.prepare("1.2.4")).resolves.toBeUndefined();
    expect(f.download).toHaveBeenCalledTimes(2);
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

describe("Windows signed release discovery", () => {
  it("falls back from an invalid Latest signature and verifies both inventories", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pin = publicKey.export({ format: "jwk" }).x!;
    // Keep signature checks real while using a fixture signing key.
    const verifier = await import("@getpaseo/protocol/desktop-release-verifier");
    const originalVerify = verifier.verifyDesktopReleaseBytes;
    const verify = vi
      .spyOn(verifier, "verifyDesktopReleaseBytes")
      .mockImplementation((manifestBytes, signature, primary, primarySignature) =>
        originalVerify(manifestBytes, signature, primary, primarySignature, pin),
      );
    const primary = forkReleaseManifestV3Fixture("1.2.4");
    const primaryBytes = Buffer.from(JSON.stringify(primary));
    const desktop = {
      ...primary,
      schemaVersion: 1,
      primaryManifestSha256: createHash("sha256").update(primaryBytes).digest("hex"),
      artifacts: [
        artifact,
        ...(["x64", "arm64"] as const).map((arch) => ({
          platform: "linux",
          arch,
          kind: "nix-desktop",
          name: `paseo-1.2.4-linux-${arch}-nix.tar`,
          bytes: 123,
          sha256: "a".repeat(64),
          system: arch === "x64" ? "x86_64-linux" : "aarch64-linux",
          outputPath: `/nix/store/${"b".repeat(32)}-paseo-desktop-1.2.4`,
          outputPaths: [
            `/nix/store/${"a".repeat(32)}-paseo-1.2.4`,
            `/nix/store/${"b".repeat(32)}-paseo-desktop-1.2.4`,
          ],
          closureManifest: {
            name: `paseo-1.2.4-linux-${arch}-nix.json`,
            bytes: 12,
            sha256: "a".repeat(64),
          },
        })),
      ],
    };
    const desktopBytes = Buffer.from(JSON.stringify(desktop));
    const signed = (data: Buffer) =>
      Buffer.from(sign(null, data, privateKey).toString("base64url"));
    const files = new Map([
      ["paseo-release-manifest.json", primaryBytes],
      ["paseo-release-manifest.sig", signed(primaryBytes)],
      ["paseo-desktop-manifest.json", desktopBytes],
      ["paseo-desktop-manifest.sig", signed(desktopBytes)],
    ]);
    const requests: string[] = [];
    const releaseList = ["1.2.9", "1.2.4"].map((version) => ({
      tag_name: `paseo-v${version}`,
      draft: false,
      prerelease: false,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === "https://github.com/iExalt/paseo/releases/latest") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://github.com/iExalt/paseo/releases/tag/paseo-v1.2.9" },
          });
        }
        if (url === "https://api.github.com/repos/iExalt/paseo/releases?per_page=6&page=1") {
          return new Response(JSON.stringify(releaseList));
        }
        const file = files.get(url.split("/").at(-1)!);
        if (!file) throw new Error(`Unexpected request: ${url}`);
        return new Response(
          new Uint8Array(url.includes("paseo-v1.2.9/") ? Buffer.from("invalid") : file).buffer,
        );
      }),
    );
    try {
      expect((await latestWindowsRelease()).version).toBe("1.2.4");
      expect(verify).toHaveBeenCalledTimes(2);
      expect(requests.filter((url) => url.endsWith("/latest"))).toHaveLength(1);
      expect(requests.filter((url) => url.includes("?per_page="))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      verify.mockRestore();
    }
  });
});
