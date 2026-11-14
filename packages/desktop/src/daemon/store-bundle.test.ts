import { describe, expect, it } from "vitest";
import type { DesktopInstallation } from "../features/nix-managed-install.js";
import { daemonBundleRebase, rebaseDaemonLaunch, shouldSyncInstalledCopy } from "./store-bundle.js";

const OUTPUT = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-paseo-desktop-0.21.0";
const STORE_APP = `${OUTPUT}/Applications/Paseo.app`;
const COPY = "/Applications/Paseo.app";
const NIX: DesktopInstallation = {
  mode: "nix",
  outputPath: OUTPUT,
  cliPath: `${OUTPUT}/bin/paseo-nix-update`,
  marker: { schemaVersion: 1, managedBy: "nix", packageVersion: "0.21.0", buildVersion: "0.21.0" },
};

function rebaseFor(overrides: Partial<Parameters<typeof daemonBundleRebase>[0]> = {}) {
  return daemonBundleRebase({
    platform: "darwin",
    isPackaged: true,
    installation: NIX,
    resourcesPath: `${COPY}/Contents/Resources`,
    exists: (filePath) => filePath === STORE_APP,
    ...overrides,
  });
}

describe("daemonBundleRebase", () => {
  it("moves a daemon launch from the /Applications copy onto its store bundle", () => {
    const rebase = rebaseFor();
    expect(rebase).not.toBeNull();
    const helper = "Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
    const launch = rebaseDaemonLaunch(
      {
        command: `${COPY}/${helper}`,
        args: [
          "--disable-warning=DEP0040",
          `${COPY}/Contents/Resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js`,
          "node-script",
          `${COPY}/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`,
        ],
        env: { PASEO_CLI: `${COPY}/Contents/Resources/bin/paseo`, HOME: "/Users/me" },
      },
      rebase!,
    );
    expect(launch).toEqual({
      command: `${STORE_APP}/${helper}`,
      args: [
        "--disable-warning=DEP0040",
        `${STORE_APP}/Contents/Resources/app.asar.unpacked/dist/daemon/node-entrypoint-runner.js`,
        "node-script",
        `${STORE_APP}/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`,
      ],
      // Terminals keep this path for life; the copy always names the installed version.
      env: { PASEO_CLI: `${COPY}/Contents/Resources/bin/paseo`, HOME: "/Users/me" },
    });
    // A sibling path that only shares the prefix is not inside the bundle.
    expect(rebase!(`${COPY}.staging/Contents/MacOS/Paseo`)).toBe(
      `${COPY}.staging/Contents/MacOS/Paseo`,
    );
  });

  it("launches from the running bundle everywhere else", () => {
    expect(rebaseFor({ platform: "linux" })).toBeNull();
    expect(rebaseFor({ isPackaged: false })).toBeNull();
    expect(rebaseFor({ installation: { mode: "electron" } })).toBeNull();
    expect(rebaseFor({ installation: { mode: "nix-invalid", error: "bad" } })).toBeNull();
    expect(rebaseFor({ resourcesPath: `${STORE_APP}/Contents/Resources` })).toBeNull();
    expect(rebaseFor({ exists: () => false })).toBeNull();
  });
});

describe("shouldSyncInstalledCopy", () => {
  it("syncs the copy only while the app runs from its store bundle", () => {
    expect(shouldSyncInstalledCopy(`${STORE_APP}/Contents/Resources`)).toBe(true);
    expect(shouldSyncInstalledCopy(`${COPY}/Contents/Resources`)).toBe(false);
  });
});
