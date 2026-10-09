import { describe, expect, it } from "vitest";
import { NIX_MANAGED_MARKER_NAME, resolveDesktopInstallation } from "./nix-managed-install";

const outputPath = `/nix/store/${"a".repeat(32)}-paseo-desktop-1.2.3`;
const resourcesPath = `${outputPath}/Applications/Paseo.app/Contents/Resources`;
const marker = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    managedBy: "nix",
    packageVersion: "1.2.3",
    buildVersion: "1.2.3.20261009",
  }),
);

function testFileSystem(markerBytes: Buffer, root = outputPath) {
  const cliPath = `${root}/bin/paseo-nix-update`;
  return {
    readFileSync(filePath: string) {
      if (filePath.endsWith(NIX_MANAGED_MARKER_NAME)) return markerBytes;
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
    realpathSync(filePath: string) {
      if (filePath === resourcesPath) return resourcesPath;
      if (filePath === `${root}/Applications/Paseo.app/Contents/Resources`) return filePath;
      if (filePath === `${root}/bin/paseo-nix-update`) return cliPath;
      if (filePath === `${resourcesPath}/../../../..`) return root;
      return filePath;
    },
    statSync() {
      return { isFile: () => true };
    },
  };
}

describe("Nix-managed desktop marker", () => {
  it("resolves the updater only from the marked immutable store output", () => {
    expect(resolveDesktopInstallation(resourcesPath, testFileSystem(marker))).toEqual({
      mode: "nix",
      outputPath,
      cliPath: `${outputPath}/bin/paseo-nix-update`,
      marker: JSON.parse(marker.toString("utf8")),
    });
  });

  it("fails closed for malformed or copied markers instead of choosing Electron updates", () => {
    expect(
      resolveDesktopInstallation(resourcesPath, testFileSystem(Buffer.from("not json"))).mode,
    ).toBe("nix-invalid");
    expect(
      resolveDesktopInstallation(
        "/Applications/Paseo.app/Contents/Resources",
        testFileSystem(marker, "/Applications/Paseo.app"),
      ).mode,
    ).toBe("nix-invalid");
  });

  it("keeps unmarked desktop installations on the existing Electron updater path", () => {
    expect(
      resolveDesktopInstallation(resourcesPath, {
        ...testFileSystem(marker),
        readFileSync: () => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        },
      }),
    ).toEqual({ mode: "electron" });
  });
});
