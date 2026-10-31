import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PluginService } from "./index.js";
import { ManagedPluginSources } from "./managed-source.js";
import { bindTestSessionHost, createStore } from "./test-utils/plugin-service.js";
import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../../scripts/test-support/npm-registry.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("npm plugin installation", () => {
  let registry: Awaited<ReturnType<typeof startNpmRegistry>>;

  // Give real npm fixture construction its own setup budget so it does not consume
  // the installation journey on Windows.
  beforeAll(async () => {
    const packages = npmPluginPackages();
    const fixture = packages[1];
    packages.push({ ...fixture, version: "2.0.0", tags: ["future"] });
    const failures: Array<[string, Record<string, string>]> = [
      ["bad-manifest", { "paseo-plugin.json": "{}" }],
      [
        "bad-build",
        {
          "paseo-plugin.json": JSON.stringify({
            id: "bad-build",
            requirements: { paseo: ">=0.4.0" },
            build: [[process.execPath, "-e", "throw new Error('preparation failed')"]],
          }),
        },
      ],
      [
        "bad-requirements",
        {
          "paseo-plugin.json": JSON.stringify({
            id: "bad-requirements",
            requirements: { paseo: ">=999.0.0" },
          }),
        },
      ],
      ["bad-code", { "index.server.ts": "invalid syntax !!!" }],
      [
        "bad-activation",
        { "index.server.ts": "export default () => { throw new Error('activation failed'); };" },
      ],
    ];
    const failedPackages = [];
    for (const [name, overrides] of failures) {
      failedPackages.push({ ...fixture, name, files: { ...fixture.files, ...overrides } });
    }
    registry = await startNpmRegistry([
      ...packages,
      {
        name: "paseo-prepared-plugin",
        version: "1.0.0",
        dependencies: { "paseo-fixture-dependency": "1.0.0" },
        scripts: { postinstall: "node -e \"throw new Error('npm lifecycle must not run')\"" },
        files: {
          "nested/paseo-plugin.json": JSON.stringify({
            id: "prepared",
            requirements: { paseo: ">=0.4.0" },
            build: [
              [
                process.execPath,
                "-e",
                "require('node:fs').mkdirSync('server'); require('node:fs').writeFileSync('server/generated.js', 'export default 42;');",
              ],
            ],
          }),
          "nested/index.server.ts": `import generated from "./server/generated.js";
import dependency from "paseo-fixture-dependency";
import { z } from "zod";
export default function contribute() {
  if (generated !== 42 || z.string().parse(dependency) !== "dependency loaded") throw new Error("Preparation failed");
  return () => {};
}`,
        },
      },
      ...failedPackages,
    ]);
  }, 120_000);

  it("preserves dependencies and metadata, and reloads without npm", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-npm-service-"));
    roots.push(home);
    const previousConfig = process.env.npm_config_userconfig;
    const previousPath = process.env.PATH;
    process.env.npm_config_userconfig = registry.userconfig;
    const store = createStore(home);
    const open = () =>
      bindTestSessionHost(
        new PluginService(pino({ level: "silent" }), store, "0.8.0", {
          managedSources: new ManagedPluginSources(home),
        }),
      );
    let service = open();
    try {
      await service.start();
      const installed = await service.installSource({ source: "npm:paseo-fixture-plugin@^1.0.0" });
      expect(installed).toMatchObject({
        id: "npm-review",
        status: "running",
        installation: {
          identity: { kind: "npm", packageName: "paseo-fixture-plugin", pluginPath: "." },
          currentRevision: "1.1.0",
        },
      });
      expect(installed.commit).toBeUndefined();
      expect(installed.remote).toBeUndefined();
      expect(
        service
          .getLogs("npm-review")
          .map((entry) => entry.message)
          .join("\n"),
      ).toContain("dependency loaded");
      const installRoot = path.dirname(path.dirname(installed.path));
      expect(
        JSON.parse(await readFile(path.join(home, "plugins", "sources.json"), "utf8"))[
          "npm-review"
        ],
      ).toEqual({ kind: "npm" });
      expect(
        JSON.parse(await readFile(path.join(installRoot, "package-lock.json"), "utf8")).packages[
          "node_modules/paseo-fixture-dependency"
        ].version,
      ).toBe("1.0.0");
      for (const [source, id, version] of [
        ["npm:paseo-fixture-plugin@1.0.0", "exact", "1.0.0"],
        ["paseo-fixture-plugin@stable", "tag", "1.0.0"],
        ["npm:@paseo-fixture/review", "scoped", "2.0.0"],
      ]) {
        expect(await service.installSource({ source, id })).toMatchObject({
          id,
          status: "running",
          installation: { currentRevision: version },
        });
      }
      const [preview] = await service.previewUpdates({ pluginId: "exact" });
      expect(preview).toMatchObject({
        outcome: "update",
        current: { currentRevision: "1.0.0" },
        target: { version: "1.1.0" },
      });
      const before = (await service.listPlugins()).find((item) => item.id === "exact")!;
      await service.disablePlugin("exact");
      registry.setTag("paseo-fixture-plugin", "latest", "2.0.0");
      const results = await service.applyUpdates([
        { ...preview!.proposal!, id: "missing-plugin" },
        preview!.proposal!,
      ]);
      expect(results).toMatchObject([
        { outcome: "error" },
        {
          outcome: "updated",
          plugin: { enabled: false, installation: { currentRevision: "1.1.0" } },
        },
      ]);
      expect(results[1]?.plugin?.installation?.identity).toEqual(before.installation?.identity);
      registry.setTag("paseo-fixture-plugin", "latest", "1.1.0");
      expect(await service.applyUpdates([preview!.proposal!])).toMatchObject([
        { outcome: "error", error: expect.stringContaining("changed since review") },
      ]);
      await service.enablePlugin("exact");
      const [future] = await service.previewUpdates({
        pluginId: "exact",
        target: { kind: "npm", version: "future" },
      });
      expect(await service.applyUpdates([future!.proposal!])).toMatchObject([
        { outcome: "updated", plugin: { installation: { currentRevision: "2.0.0" } } },
      ]);
      const [newer] = await service.previewUpdates({ pluginId: "exact" });
      expect(newer).toMatchObject({
        outcome: "installed-newer",
        current: { currentRevision: "2.0.0" },
        target: { version: "1.1.0" },
      });
      expect(newer?.proposal).toBeUndefined();
      const [downgrade] = await service.previewUpdates({
        pluginId: "exact",
        target: { kind: "npm", version: "1.0.0" },
      });
      const wrongArtifact = {
        ...downgrade!.proposal!,
        target: { ...downgrade!.proposal!.target, integrity: "sha512-invalid" },
      };
      expect(await service.applyUpdates([wrongArtifact])).toMatchObject([{ outcome: "error" }]);
      expect(await service.applyUpdates([downgrade!.proposal!])).toMatchObject([
        { outcome: "updated", plugin: { installation: { currentRevision: "1.0.0" } } },
      ]);
      expect((await service.previewUpdates({ pluginId: "exact" }))[0]?.outcome).toBe("update");
      await expect(service.updateSources("exact")).rejects.toThrow("Update the client");
      const prepared = await service.installSource({
        source: "npm:paseo-prepared-plugin@1.0.0:nested",
      });
      expect(prepared).toMatchObject({ id: "prepared", status: "running" });
      expect(await readFile(path.join(prepared.path, "server/generated.js"), "utf8")).toBe(
        "export default 42;",
      );
      expect(prepared.installation).toMatchObject({ identity: { pluginPath: "nested" } });
      await service.removePlugin("prepared");
      expect(registry.requests).not.toContain("/@getpaseo/plugin");
      await expect(service.installSource({ source: "npm:missing-plugin" })).rejects.toThrow();
      await expect(
        service.installSource({ source: "npm:paseo-fixture-plugin", ref: "main" }),
      ).rejects.toThrow("--ref is only valid for Git");
      await expect(service.installSource({ source: "npm:paseo-fixture-plugin" })).rejects.toThrow(
        "already configured",
      );
      expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      for (const name of [
        "bad-manifest",
        "bad-build",
        "bad-requirements",
        "bad-code",
        "bad-activation",
      ]) {
        await expect(service.installSource({ source: `npm:${name}`, id: name })).rejects.toThrow();
        expect((await service.listPlugins()).map((plugin) => plugin.id)).toEqual([
          "exact",
          "npm-review",
          "scoped",
          "tag",
        ]);
        expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      }
      await service.disablePlugin("scoped");
      await service.stopAllPlugins();
      const recordsPath = path.join(home, "plugins", "sources.json");
      const oldRecords = JSON.parse(await readFile(recordsPath, "utf8"));
      Object.assign(oldRecords["npm-review"], {
        requestedSpec: "0.0.1",
        version: "0.0.1",
        packageName: "obsolete",
        installRoot: "/obsolete",
        integrity: "obsolete",
      });
      await writeFile(recordsPath, JSON.stringify(oldRecords));
      process.env.PATH = path.join(home, "no-executables");
      service = open();
      await service.start();
      expect(await service.listPlugins()).toMatchObject(
        expect.arrayContaining([
          expect.objectContaining({
            id: "npm-review",
            status: "running",
            installation: installed.installation,
          }),
          expect.objectContaining({ id: "scoped", enabled: false, status: "disabled" }),
        ]),
      );
      expect(await service.reloadPlugin("npm-review")).toMatchObject({
        status: "running",
        installation: installed.installation,
      });
      await expect(
        service.installSource({ source: "npm:paseo-fixture-plugin", id: "missing-npm" }),
      ).rejects.toThrow("npm is required on the daemon host");
      expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      const packagePath = path.join(installed.path, "package.json");
      const packageJson = await readFile(packagePath, "utf8");
      await writeFile(
        packagePath,
        JSON.stringify({ ...JSON.parse(packageJson), version: "99.0.0" }),
      );
      const corrupt = (await service.listPlugins()).find((plugin) => plugin.id === "npm-review")!;
      expect(corrupt.status).toBe("running");
      expect(corrupt.installation).toEqual({ identity: installed.installation!.identity });
      expect((await service.previewUpdates({ pluginId: "npm-review" }))[0]).toMatchObject({
        outcome: "error",
        error: expect.stringContaining("Installed revision is unavailable"),
      });
      expect(await service.reloadPlugin("npm-review")).toMatchObject({ status: "running" });
      await writeFile(packagePath, packageJson);
      await service.removePlugin("npm-review");
      await expect(stat(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(await readFile(path.join(home, "plugins", "sources.json"), "utf8"))[
          "npm-review"
        ],
      ).toBeUndefined();
    } finally {
      process.env.PATH = previousPath;
      if (previousConfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = previousConfig;
      await service.stopAllPlugins();
      await registry.close();
    }
  }, 120_000);
});
