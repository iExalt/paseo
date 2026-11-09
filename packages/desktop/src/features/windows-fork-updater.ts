import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareForkVersions,
  forkVersionFromTag,
  parseForkVersion,
} from "@getpaseo/protocol/fork-version";
import {
  DESKTOP_MANIFEST_ASSET,
  DESKTOP_SIGNATURE_ASSET,
  type DesktopReleaseManifest,
  type DesktopReleaseArtifact,
} from "@getpaseo/protocol/desktop-release-manifest";
import { verifyDesktopReleaseBytes } from "@getpaseo/protocol/desktop-release-verifier";
import { Provider, type ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { NsisUpdater, type AppUpdater } from "electron-updater";
export class ForkNsisUpdater extends NsisUpdater {
  get forkInstallerPath(): string | null {
    return this.installerPath;
  }
  resetForkHandoff(): void {
    this.quitAndInstallCalled = false;
  }
}
import type { UpdateInfo, CustomPublishOptions } from "builder-util-runtime";
const releases = "https://github.com/iExalt/paseo/releases";
const maxMetadata = 1024 * 1024;
export const forkAssetUrl = (tag: string, name: string): string =>
  `${releases}/download/${tag}/${name}`;
async function metadata(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body)
    throw new Error(
      `Fork update metadata is unavailable (HTTP ${response.status}). This release may require a manual installation.`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxMetadata) throw new Error("Fork update metadata exceeds its size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function latestWindowsRelease(): Promise<DesktopReleaseManifest> {
  const response = await fetch(`${releases}/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const location = new URL(response.headers.get("location") ?? "", `${releases}/latest`);
  const prefix = "/iExalt/paseo/releases/tag/";
  const tag = location.pathname.slice(prefix.length);
  if (
    ![301, 302, 303, 307, 308].includes(response.status) ||
    location.origin !== "https://github.com" ||
    !location.pathname.startsWith(prefix) ||
    location.search ||
    location.hash ||
    forkVersionFromTag(tag) === null
  )
    throw new Error("The latest release is not a stable Paseo fork release.");
  const [bytes, signature, primary, primarySignature] = await Promise.all(
    [
      DESKTOP_MANIFEST_ASSET,
      DESKTOP_SIGNATURE_ASSET,
      "paseo-release-manifest.json",
      "paseo-release-manifest.sig",
    ].map((name) => metadata(forkAssetUrl(tag, name))),
  );
  const manifest = verifyDesktopReleaseBytes(bytes, signature, primary, primarySignature);
  if (manifest.releaseTag !== tag)
    throw new Error("Fork update metadata names a different release.");
  return manifest;
}
type WindowsArtifact = Extract<DesktopReleaseArtifact, { platform: "windows" }>;
function installer(manifest: DesktopReleaseManifest): WindowsArtifact {
  const artifact = manifest.artifacts.find(
    (entry): entry is WindowsArtifact => entry.platform === "windows",
  );
  if (!artifact) throw new Error("This fork release has no Windows x64 installer.");
  return artifact;
}
export async function verifyForkInstaller(file: string, artifact: WindowsArtifact): Promise<void> {
  if ((await stat(file)).size !== artifact.bytes)
    throw new Error("Fork installer size differs from signed metadata.");
  const sha256 = createHash("sha256"),
    sha512 = createHash("sha512");
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  if (sha256.digest("hex") !== artifact.sha256 || sha512.digest("base64") !== artifact.sha512)
    throw new Error(
      "Fork installer digest differs from signed metadata. Check and download again.",
    );
}
/** Installed floor advances from the running version only, never a staged or canceled installer. */
export async function installedForkFloor(file: string, runningVersion: string): Promise<string> {
  parseForkVersion(runningVersion);
  let floor = runningVersion;
  try {
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    parseForkVersion(saved);
    if (compareForkVersions(saved as string, floor) > 0) floor = saved as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(floor), { mode: 0o600 });
  await rename(temporary, file);
  return floor;
}
export function createForkWindowsProvider(input: {
  latest: () => Promise<DesktopReleaseManifest>;
  floor: () => Promise<string>;
}): NonNullable<CustomPublishOptions["updateProvider"]> {
  return class ForkWindowsProvider extends Provider<UpdateInfo> {
    private selected: DesktopReleaseManifest | null = null;
    constructor(
      _options: CustomPublishOptions,
      _updater: AppUpdater,
      runtime: ProviderRuntimeOptions,
    ) {
      super(runtime);
    }
    async getLatestVersion(): Promise<UpdateInfo> {
      const manifest = await input.latest();
      if (compareForkVersions(manifest.version, await input.floor()) < 0)
        throw new Error("Fork release is older than the installed version. Update refused.");
      this.selected = manifest;
      const artifact = installer(manifest);
      return {
        version: manifest.version,
        path: artifact.name,
        sha512: artifact.sha512,
        releaseDate: "",
        files: [{ url: artifact.name, sha512: artifact.sha512, size: artifact.bytes }],
      };
    }
    resolveFiles(info: UpdateInfo) {
      const manifest = this.selected;
      if (!manifest || info.version !== manifest.version)
        throw new Error("Fork installer has no verified release metadata.");
      const artifact = installer(manifest);
      return [
        {
          url: new URL(forkAssetUrl(manifest.releaseTag, artifact.name)),
          info: { url: artifact.name, sha512: artifact.sha512, size: artifact.bytes },
        },
      ];
    }
  };
}
export function configureForkWindowsUpdater(
  updater: ForkNsisUpdater,
  input: {
    platform: NodeJS.Platform;
    arch: string;
    stateDirectory: string;
    runningVersion: string;
    latest?: () => Promise<DesktopReleaseManifest>;
  },
): (version: string) => Promise<void> {
  if (input.platform !== "win32" || input.arch !== "x64")
    throw new Error(
      "Automatic fork updates require Windows x64 or a managed Nix installation. Install a supported fork package manually.",
    );
  const latest = input.latest ?? latestWindowsRelease;
  const floor = () =>
    installedForkFloor(
      path.join(input.stateDirectory, "fork-installed-version.json"),
      input.runningVersion,
    );
  let downloadedFile: string | null = null;
  let downloadedVersion: string | null = null;
  updater.on("update-downloaded", (event) => {
    downloadedFile = event.downloadedFile;
    downloadedVersion = event.version;
  });
  updater.setFeedURL({
    provider: "custom",
    updateProvider: createForkWindowsProvider({ latest, floor }),
  });
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  return async (version) => {
    const manifest = await latest();
    if (manifest.version !== version || compareForkVersions(version, await floor()) <= 0)
      throw new Error("Fork release changed. Check for updates again.");
    const selectedPath = updater.forkInstallerPath;
    if (!selectedPath || selectedPath !== downloadedFile || downloadedVersion !== version)
      throw new Error("Fork installer selection changed. Check and download again.");
    await verifyForkInstaller(selectedPath, installer(manifest));
    if (
      updater.forkInstallerPath !== selectedPath ||
      downloadedFile !== selectedPath ||
      downloadedVersion !== version
    )
      throw new Error("Fork installer selection changed during verification.");
  };
}
