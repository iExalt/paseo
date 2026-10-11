import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appImageSupervisorLaunch } from "./appimage-supervisor.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-supervisor-"));
  roots.push(root);
  const mount = path.join(root, "mount");
  const entry = path.join(
    mount,
    "resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js",
  );
  mkdirSync(path.dirname(entry), { recursive: true });
  const execPath = path.join(mount, "Paseo.bin");
  const image = path.join(root, "Paseo.AppImage");
  for (const file of [entry, execPath, image]) writeFileSync(file, "fixture");
  chmodSync(image, 0o700);
  const cli = path.join(root, "paseo");
  symlinkSync(image, cli);
  return {
    platform: "linux",
    electron: "44.6.0",
    execPath,
    entry,
    env: { APPDIR: mount, APPIMAGE: image, PASEO_CLI: cli, ELECTRON_RUN_AS_NODE: "1" },
  };
}
describe("AppImage supervisor launch", () => {
  it("preserves only the verified desktop-owned shim outside installed-link mode", () => {
    const input = fixture();
    const shim = path.join(input.env.APPDIR, "resources/bin/paseo");
    mkdirSync(path.dirname(shim), { recursive: true });
    writeFileSync(shim, "fixture");
    expect(
      appImageSupervisorLaunch({
        ...input,
        env: { ...input.env, PASEO_CLI: shim, ARGV0: input.env.APPIMAGE },
      }),
    ).toBeUndefined();
    expect(() =>
      appImageSupervisorLaunch({
        ...input,
        env: { ...input.env, PASEO_CLI: shim, ARGV0: input.env.PASEO_CLI },
      }),
    ).toThrow("installed CLI link");
  });
  it("uses a fresh invocation and preserves the stable link and environment", () => {
    const input = fixture();
    expect(appImageSupervisorLaunch(input)).toEqual({
      command: input.env.APPIMAGE,
      args: [],
      env: { ...input.env, PASEO_APPIMAGE_SUPERVISOR: "1" },
    });
    expect(input.env).not.toHaveProperty("PASEO_APPIMAGE_SUPERVISOR");
  });
  it("leaves ordinary runtimes and packages unchanged", () => {
    const input = fixture();
    for (const patch of [
      { platform: "darwin" },
      { electron: undefined },
      { env: { ...input.env, APPIMAGE: undefined } },
      { env: { ...input.env, ELECTRON_RUN_AS_NODE: undefined } },
    ]) {
      expect(appImageSupervisorLaunch({ ...input, ...patch })).toBeUndefined();
    }
  });
  it("rejects an outside executable, different entry, or mismatched installed link", () => {
    const input = fixture();
    expect(() => appImageSupervisorLaunch({ ...input, execPath: input.env.APPIMAGE })).toThrow(
      "outside",
    );
    expect(() => appImageSupervisorLaunch({ ...input, entry: input.execPath })).toThrow("outside");
    expect(() =>
      appImageSupervisorLaunch({ ...input, env: { ...input.env, PASEO_CLI: input.execPath } }),
    ).toThrow("installed CLI link");
  });
});
