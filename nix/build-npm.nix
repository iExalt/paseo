{
  lib,
  stdenvNoCC,
  fetchurl,
  nodejs_26,
}:

let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
  version = lib.removePrefix "npm@" manifest.packageManager;
in
stdenvNoCC.mkDerivation {
  pname = "paseo-build-npm";
  inherit version;

  src = fetchurl {
    url = "https://registry.npmjs.org/npm/-/npm-${version}.tgz";
    hash = "sha512-ovmNRRe76Jvcp1E6iOePQ6H9Zr4XMOrqgfaeGNhtRvP3XSl2Lo/a9C1N5/jRlLLrsqCem/omgGdZHpZ5a6yn1Q==";
  };

  # Keep the Nix Node distribution's patched node-gyp ahead of project tools.
  postPatch = ''
    substituteInPlace node_modules/@npmcli/run-script/lib/set-path.js \
      --replace-fail 'const pathArr = []' 'const pathArr = [nodeGypPath]' \
      --replace-fail 'pathArr.push(nodeGypPath, PATH)' 'pathArr.push(PATH)'
  '';

  dontBuild = true;
  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/npm" "$out/bin"
    cp -r . "$out/lib/npm/"
    ln -s ../lib/npm/bin/npm-cli.js "$out/bin/npm"
    ln -s ../lib/npm/bin/npx-cli.js "$out/bin/npx"
    substituteInPlace "$out/lib/npm/bin/npm-cli.js" "$out/lib/npm/bin/npx-cli.js" \
      --replace-fail '#!/usr/bin/env node' "#!${nodejs_26}/bin/node"

    runHook postInstall
  '';
}
