import { afterEach, expect, test, vi } from "vitest";

const paths = vi.hoisted(() => ({
  bundle: "/Applications/Paseo.app",
  store: "/nix/store/installed-paseo-2.0.0",
  missing: "",
  markerVersion: "2.0.0",
}));
const access = vi.hoisted(() => vi.fn());
vi.mock("@getpaseo/server/daemon-control", () => ({
  startDaemonInstance: vi.fn(),
  resolvePaseoHome: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: () =>
      `${paths.bundle}/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/exports.js`,
  }),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  existsSync: (file: string) =>
    file.endsWith("/@getpaseo/server/package.json") ||
    file.endsWith("supervisor-entrypoint.js") ||
    file.endsWith("paseo-nix-managed.json"),
  readFileSync: (file: string) =>
    JSON.stringify(
      file.endsWith("paseo-nix-managed.json")
        ? {
            schemaVersion: 1,
            managedBy: "nix",
            outputPath: paths.store,
            packageVersion: paths.markerVersion,
          }
        : { name: "@getpaseo/server", version: "2.0.0" },
    ),
  accessSync: (file: string, mode: number) => {
    access(file, mode);
    if (paths.missing && file.includes(paths.missing)) throw new Error("Installed runner missing");
  },
}));
import { prepareLocalDaemonLaunch } from "./local-daemon.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
const oldCli = process.env.PASEO_CLI;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "execPath", executable);
  if (oldCli === undefined) delete process.env.PASEO_CLI;
  else process.env.PASEO_CLI = oldCli;
  paths.missing = "";
  paths.markerVersion = "2.0.0";
  access.mockClear();
});
function mac() {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  Object.defineProperty(process, "execPath", {
    ...executable,
    value: `${paths.bundle}/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper`,
  });
  process.env.PASEO_CLI = `${paths.bundle}/Contents/Resources/bin/paseo`;
}
test("Nix macOS replacement captures immutable Helper/code paths and retains the stable CLI link", () => {
  mac();
  const launch = prepareLocalDaemonLaunch();
  expect(launch.command).toBe(
    `${paths.store}/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper`,
  );
  expect(launch.args).toEqual([
    `${paths.store}/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`,
  ]);
  expect(launch.env.PASEO_CLI).toBe(`${paths.bundle}/Contents/Resources/bin/paseo`);
  expect(launch.version).toBe("2.0.0");
  expect(access).toHaveBeenCalledTimes(2);
});
test.each(["supervisor-entrypoint.js", "Paseo Helper"])(
  "missing installed %s fails preflight",
  (missing) => {
    mac();
    paths.missing = missing;
    expect(() => prepareLocalDaemonLaunch()).toThrow("Installed runner missing");
  },
);
test("a stale or malformed managed marker cannot select another release", () => {
  mac();
  paths.markerVersion = "1.0.0";
  expect(() => prepareLocalDaemonLaunch()).toThrow("Invalid Nix-managed daemon installation");
});
