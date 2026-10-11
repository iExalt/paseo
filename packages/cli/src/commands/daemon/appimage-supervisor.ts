import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

// A detached binary inside the CLI's FUSE mount loses its files when that
// invocation exits. Launch the AppImage again so the supervisor owns its mount.
export function appImageSupervisorLaunch(input: {
  platform: string;
  electron?: string;
  execPath: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  const { env } = input;
  if (
    input.platform !== "linux" ||
    !input.electron ||
    env.ELECTRON_RUN_AS_NODE !== "1" ||
    !env.APPIMAGE ||
    !env.APPDIR
  )
    return undefined;
  const mount = realpathSync(env.APPDIR);
  const expected = path.join(
    mount,
    "resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js",
  );
  if (
    path.dirname(realpathSync(input.execPath)) !== mount ||
    realpathSync(input.entry) !== realpathSync(expected)
  )
    throw new Error("AppImage supervisor entry is outside the current bundle");
  // The desktop owns its mount and supplies this exact bundled shim to agents.
  // Preserve that existing launch path; only installed links need a fresh mount.
  if (
    path.basename(env.ARGV0 ?? "") !== "paseo" &&
    env.PASEO_CLI &&
    realpathSync(env.PASEO_CLI) === path.join(mount, "resources/bin/paseo")
  )
    return undefined;
  accessSync(env.APPIMAGE, constants.X_OK);
  const image = statSync(env.APPIMAGE);
  const cli = env.PASEO_CLI ? statSync(env.PASEO_CLI) : undefined;
  if (!image.isFile() || !cli || cli.dev !== image.dev || cli.ino !== image.ino) {
    throw new Error("AppImage supervisor requires the installed CLI link");
  }
  return {
    command: path.resolve(env.APPIMAGE),
    args: [],
    env: { ...env, PASEO_APPIMAGE_SUPERVISOR: "1" },
  };
}
