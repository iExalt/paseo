import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import type { DesktopInstallation } from "../../features/nix-managed-install.js";
import { cliIsInstalled, installLinuxNixCli } from "./install-files.js";

const it = test.runIf(process.platform !== "win32");
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function installation(outputPath: string): Extract<DesktopInstallation, { mode: "nix" }> {
  return {
    mode: "nix",
    outputPath,
    cliPath: join(outputPath, "bin/paseo-nix-update"),
    marker: {
      schemaVersion: 1,
      managedBy: "nix",
      packageVersion: "0.1.0",
      buildVersion: "0.1.0",
      outputPath,
    },
  };
}
const cliPath = (output: string) => join(output, "share/paseo-desktop/packages/cli/bin/paseo");
async function setup() {
  root = await mkdtemp(join(tmpdir(), "paseo-cli-install-"));
  const output = join(root, "old-output");
  const stateRoot = join(root, "state/paseo/nix-update");
  const profile = join(stateRoot, "profile");
  const target = join(root, "bin/paseo");
  const shim = cliPath(output);
  await mkdir(join(stateRoot, "semver-v1"), { recursive: true });
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(shim), { recursive: true });
  await writeFile(shim, "old CLI", { mode: 0o755 });
  await writeFile(
    join(stateRoot, "semver-v1/profile-state.json"),
    JSON.stringify({ current: { outputPath: output } }),
  );
  await symlink(output, profile);
  return {
    installation: installation(output),
    activeInstallation: installation(output) as DesktopInstallation,
    profile,
    target,
    shim,
  };
}

it("owned CLI follows profile switches, and an old running app cannot repin it", async () => {
  const input = await setup();
  await symlink(input.shim, input.target);
  await installLinuxNixCli(input);
  expect(await readlink(input.target)).toBe(cliPath(input.profile));
  const next = join(root, "new-output");
  await mkdir(dirname(cliPath(next)), { recursive: true });
  await writeFile(cliPath(next), "new CLI", { mode: 0o755 });
  await rm(input.profile);
  await symlink(next, input.profile);
  await writeFile(
    join(dirname(input.profile), "semver-v1/profile-state.json"),
    JSON.stringify({ current: { outputPath: next } }),
  );
  input.activeInstallation = installation(next);
  await installLinuxNixCli(input);
  expect(await readlink(input.target)).toBe(cliPath(input.profile));
  // A first CLI install from the still-running old app must also select the new active profile.
  await rm(input.target);
  await installLinuxNixCli(input);
  expect(await readlink(input.target)).toBe(cliPath(input.profile));
  await rm(input.installation.outputPath, { recursive: true });
  expect(await readFile(input.target, "utf8")).toBe("new CLI");
  expect(await cliIsInstalled(input.target, "linux")).toBe(true);
  await rm(next, { recursive: true });
  expect((await lstat(input.target)).isSymbolicLink()).toBe(true);
  expect(await cliIsInstalled(input.target, "linux")).toBe(false);
});

it("Nix CLI installation preserves foreign files and links, and reports non-executable targets", async () => {
  const input = await setup();
  await writeFile(input.target, "foreign", { mode: 0o755 });
  await expect(installLinuxNixCli(input)).rejects.toThrow("another installation");
  expect(await readFile(input.target, "utf8")).toBe("foreign");
  await rm(input.target);
  await symlink("/foreign/missing/cli", input.target);
  await expect(installLinuxNixCli(input)).rejects.toThrow("another installation");
  expect(await readlink(input.target)).toBe("/foreign/missing/cli");
  expect(await cliIsInstalled(input.target, "linux")).toBe(false);
  await rm(input.target);
  await writeFile(input.target, "not executable");
  await chmod(input.target, 0o644);
  expect(await cliIsInstalled(input.target, "linux")).toBe(false);
});

it("pre-bootstrap and unowned profiles keep immutable CLI until verified adoption", async () => {
  const input = await setup();
  const stateFile = join(dirname(input.profile), "semver-v1/profile-state.json");
  await rm(stateFile);
  await installLinuxNixCli(input);
  expect(await readlink(input.target)).toBe(input.shim);
  await writeFile(stateFile, JSON.stringify({ current: { outputPath: "/foreign/output" } }));
  await installLinuxNixCli(input);
  expect(await readlink(input.target)).toBe(input.shim);
  await writeFile(
    stateFile,
    JSON.stringify({ current: { outputPath: input.installation.outputPath } }),
  );
  input.activeInstallation = { mode: "nix-invalid", error: "unverified marker" };
  await installLinuxNixCli(input);
  expect(await readlink(input.target)).toBe(input.shim);
});
