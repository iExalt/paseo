import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const headless = readFileSync(require.resolve("@xterm/headless"), "utf8");
const entry = resolve(import.meta.dirname, "../..", "index.ts");

function startup(navigator: Record<string, unknown> | undefined, omitInstaller = false) {
  const context = vm.createContext({ navigator });
  context.window = context;
  let rootLoaded = false;
  const load = (filename: string): unknown => {
    if (omitInstaller && filename.endsWith("/install-navigator-polyfill.ts")) return {};
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    const localRequire = (name: string) => {
      if (name === "./src/root-app") {
        const library = { exports: {} };
        vm.runInContext(`(function(module,exports){${headless}\n})`, context, { timeout: 1000 })(
          library,
          library.exports,
        );
        rootLoaded = true;
        return { RootApp: () => null };
      }
      if (name.includes("navigator")) return load(resolve(dirname(filename), name + ".ts"));
      if (name.endsWith("/crypto")) return { polyfillCrypto() {} };
      if (name.endsWith("/screen-orientation")) return { polyfillScreenOrientation() {} };
      if (name.endsWith("/mode")) return { preferencesMigrationMode: () => false };
      if (name.endsWith("/renderRootComponent")) return { renderRootComponent() {} };
      if (
        [
          "./src/styles/unistyles",
          "@expo/metro-runtime",
          "expo-router/build/fast-refresh",
        ].includes(name)
      )
        return {};
      throw new Error(`Unexpected entry dependency: ${name}`);
    };
    vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { timeout: 1000 })(
      localRequire,
      module,
      module.exports,
    );
    return module.exports;
  };
  load(entry);
  expect(rootLoaded).toBe(true);
  return context.navigator;
}

it("initializes navigator before the actual entry loads its native terminal dependency", () => {
  expect(() => startup({}, true)).toThrow(/includes/);
  expect(startup({})).toEqual({ userAgent: "ReactNative", platform: "" });
  expect(startup(undefined)).toEqual({ userAgent: "ReactNative", platform: "" });
  const browser = { userAgent: "Browser", platform: "MacIntel" };
  expect(startup(browser)).toBe(browser);
  expect(browser).toEqual({ userAgent: "Browser", platform: "MacIntel" });
});
