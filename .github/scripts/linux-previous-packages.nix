# Disposable predecessor only: repair packaging without changing old product code.
# The exact expression and its digest are retained with the native upgrade proof.
{ source }:
let
  flake = builtins.getFlake source;
  packages = flake.packages.${builtins.currentSystem};
  retainWasm = prefix: package: package.overrideAttrs (old: {
    postInstall = (old.postInstall or "") + ''
      asset=$(node --input-type=module -e '
        import { createRequire } from "node:module";
        import path from "node:path";
        const importer = path.resolve("packages/server/dist/server/server/agent/reply-rule-matcher.js");
        const resolved = createRequire(importer).resolve("re2-wasm/build/wasm/re2.wasm");
        const relative = path.relative(process.cwd(), resolved);
        if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Asset outside predecessor tree");
        console.log(relative);
      ')
      mkdir -p "$out/${prefix}/$(dirname "$asset")"
      cp "$asset" "$out/${prefix}/$asset"
      echo 'Verification-only predecessor RE2 asset:'
      sha256sum "$asset"
    '';
  });
in {
  daemon = retainWasm "lib/paseo" packages.paseo;
  desktop = retainWasm "share/paseo-desktop" packages.desktop;
}
