import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const NIX_MANAGED_MARKER_NAME = "paseo-nix-managed.json";
export const INSTALLATION_MODE_ARGUMENT_PREFIX = "--paseo-installation-mode=";

export interface NixManagedMarker {
  schemaVersion: 1;
  managedBy: "nix";
  packageVersion: string;
  buildVersion: string;
}

export type DesktopInstallation =
  | { mode: "electron" }
  | { mode: "nix"; outputPath: string; cliPath: string; marker: NixManagedMarker }
  | { mode: "nix-invalid"; error: string };

interface InstallFileSystem {
  readFileSync(filePath: string): Buffer;
  realpathSync(filePath: string): string;
  statSync(filePath: string): { isFile(): boolean };
}

function parseMarker(bytes: Buffer): NixManagedMarker {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Nix installation marker is not valid UTF-8 JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    (value as Record<string, unknown>).managedBy !== "nix" ||
    typeof (value as Record<string, unknown>).packageVersion !== "string" ||
    !(value as Record<string, unknown>).packageVersion ||
    typeof (value as Record<string, unknown>).buildVersion !== "string" ||
    !(value as Record<string, unknown>).buildVersion
  ) {
    throw new Error("Nix installation marker has an unsupported shape.");
  }
  return value as NixManagedMarker;
}

export function resolveDesktopInstallation(
  resourcesPath: string | undefined,
  fileSystem: InstallFileSystem = { readFileSync, realpathSync, statSync },
): DesktopInstallation {
  if (!resourcesPath) return { mode: "electron" };
  const markerPath = path.join(resourcesPath, NIX_MANAGED_MARKER_NAME);
  let markerBytes: Buffer;
  try {
    markerBytes = fileSystem.readFileSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "electron" };
    return { mode: "nix-invalid", error: "Could not read the Nix installation marker." };
  }
  try {
    const marker = parseMarker(markerBytes);
    const realResourcesPath = fileSystem.realpathSync(resourcesPath);
    const outputPath = fileSystem.realpathSync(path.resolve(realResourcesPath, "../../../.."));
    if (!/^\/nix\/store\/[a-z0-9]{32}-paseo-desktop-[^/]+$/.test(outputPath)) {
      throw new Error("Nix installation marker is outside a desktop store output.");
    }
    const cliPath = path.join(outputPath, "bin", "paseo-nix-update");
    const realCliPath = fileSystem.realpathSync(cliPath);
    if (realCliPath !== cliPath || !fileSystem.statSync(realCliPath).isFile()) {
      throw new Error("The managed updater CLI is missing from the marked Nix output.");
    }
    return { mode: "nix", outputPath, cliPath, marker };
  } catch (error) {
    return {
      mode: "nix-invalid",
      error: error instanceof Error ? error.message : "Nix installation marker is invalid.",
    };
  }
}

export function installationModeArgument(mode: DesktopInstallation["mode"]): string {
  return `${INSTALLATION_MODE_ARGUMENT_PREFIX}${mode}`;
}

export function readInstallationModeArgument(argv: string[]): DesktopInstallation["mode"] {
  const argument = argv.find((value) => value.startsWith(INSTALLATION_MODE_ARGUMENT_PREFIX));
  const value = argument?.slice(INSTALLATION_MODE_ARGUMENT_PREFIX.length);
  return value === "nix" || value === "nix-invalid" ? value : "electron";
}
