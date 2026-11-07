import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as nixRuntime from "./linux-update-nix.mjs";
const directory = process.env.PASEO_UPDATE_FIXTURE;
assert.ok(directory);
if (process.env.PASEO_UPDATE_MAC) {
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "arm64" });
}
const mac = new URL("../paseo-nix-update-macos.mjs", import.meta.url).href;
const macProxy = pathToFileURL(join(directory, "mac-proxy.mjs")).href;
writeFileSync(
  new URL(macProxy),
  `export * from ${JSON.stringify(mac + "?fixture-original")}; export async function syncDesktopApp(output) { return output; }`,
);
const legacy = new URL("../paseo-nix-update-legacy.mjs", import.meta.url).href;
const proxy = pathToFileURL(join(directory, "legacy-proxy.mjs")).href;
const nix = new URL("./linux-update-nix.mjs", import.meta.url).href;
writeFileSync(
  new URL(proxy),
  `export * from ${JSON.stringify(legacy + "?fixture-original")};\nexport { profileGenerations, extractNixCacheTar } from ${JSON.stringify(nix)};\n`,
);
const require = createRequire(import.meta.url);
require("node:child_process").spawnSync = (command, args) => {
  if (command === "nix-env") return nixRuntime.nixEnv(args);
  if (command === "nix")
    return nixRuntime.nix(args[0] === "--extra-experimental-features" ? args.slice(2) : args);
  throw new Error(`Fixture forbids subprocess ${command}`);
};
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).href === legacy)
      return { url: proxy, shortCircuit: true };
    if (
      process.env.PASEO_UPDATE_MAC &&
      context.parentURL &&
      new URL(specifier, context.parentURL).href === mac
    )
      return { url: macProxy, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.endsWith("/protocol/src/release-manifest.ts"))
      return {
        ...loaded,
        source: String(loaded.source).replace(
          "iseyxFToCZaOyBoHEsfbC6XN4t5eTJRbc6Qy-AQK8xc",
          process.env.PASEO_UPDATE_FIXTURE_PIN,
        ),
      };
    return loaded;
  },
});
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://github.com", "Fixture forbids outgoing requests");
  if (url.pathname === "/iExalt/paseo/releases/latest")
    return new Response(null, {
      status: 302,
      headers: {
        location: `https://github.com/iExalt/paseo/releases/tag/paseo-v${process.env.PASEO_UPDATE_LATEST}`,
      },
    });
  const match =
    /^\/iExalt\/paseo\/releases\/download\/paseo-v([0-9]+\.[0-9]+\.[0-9]+)\/([A-Za-z0-9._-]+)$/.exec(
      url.pathname,
    );
  assert.ok(match, `Unknown fixture URL ${url}`);
  const bytes = readFileSync(join(directory, "releases", match[1], match[2]));
  return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
};
