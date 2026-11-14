{
  lib,
  stdenv,
  buildNpmPackage,
  fetchNpmDeps,
  runCommand,
  writeTextDir,
  nodejs_26,
  python3,
  makeWrapper,
  autoPatchelfHook,
  # node-pty needs libuv headers on Linux
  libuv,
  # Exposed so downstream flakes that follow a different nixpkgs revision
  # (where `fetchNpmDeps` may produce a different hash for the same lockfile)
  # can override via `.override { npmDepsHash = "sha256-..."; }` without
  # `overrideAttrs` gymnastics — `npmDepsHash` is destructured from
  # `buildNpmPackage`'s args, so `overrideAttrs` cannot reach it.
  #
  # Refresh this sidecar with scripts/update-nix.sh whenever a dependency
  # changes. A version-only release update leaves it as it is.
  npmDepsHash ? lib.fileContents ./npm-deps.hash,
}:

let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  lockfile = builtins.fromJSON (builtins.readFile ../package-lock.json);
  # The registry tarballs are all the npm cache holds. The root and workspace
  # entries carry the release version, so fetching from them made every
  # release a new hash and a full refetch. This lockfile keeps only the
  # tarball entries, and the fetch has no version in its name, so a release
  # that changes no dependency reuses the same store path.
  registryLockfile = writeTextDir "package-lock.json" (builtins.toJSON {
    inherit (lockfile) lockfileVersion;
    requires = true;
    packages = lib.filterAttrs (
      key: entry: lib.hasInfix "node_modules/" key && !(entry.link or false)
    ) lockfile.packages;
  });
  registryDeps = fetchNpmDeps {
    name = "paseo-npm-deps";
    src = registryLockfile;
    hash = npmDepsHash;
  };
in
buildNpmPackage rec {
  pname = "paseo";
  inherit version;

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let
        baseName = builtins.baseNameOf path;
        relPath = lib.removePrefix (toString ./..) path;
      in
      # Exclude non-daemon workspace contents (keep package.json for workspace resolution)
      !(lib.hasPrefix "/packages/app/android" relPath)
      && !(lib.hasPrefix "/packages/app/ios" relPath)
      && !(lib.hasPrefix "/packages/website/src" relPath)
      && !(lib.hasPrefix "/packages/website/public" relPath)
      && !(lib.hasPrefix "/packages/desktop/src" relPath)
      && !(lib.hasPrefix "/packages/desktop/src-tauri" relPath)
      # Documentation, CI definitions and agent/editor configuration. None of
      # these reach the build. Excluding them here also matters for the desktop
      # derivation, which inherits this package's npmDeps: leaving them in makes
      # a docs-only commit produce a new npm-deps .drv, and so a new desktop
      # .drv, and so a full rebuild for a byte-identical result.
      && !(lib.hasPrefix "/docs" relPath)
      && !(lib.hasPrefix "/.github" relPath)
      && !(lib.hasPrefix "/.agents" relPath)
      && !(lib.hasPrefix "/.claude" relPath)
      && !(lib.hasPrefix "/.codex" relPath)
      && !(lib.hasPrefix "/docker" relPath)
      # Top-level prose only (README, CHANGELOG, AGENTS...). Deeper markdown is
      # not necessarily documentation: skills/*/SKILL.md is a runtime file the
      # daemon's trace script copies into the output.
      && builtins.match "/[^/]+\\.md" relPath == null
      # Exclude test fixtures and debug files
      && !((import ./is-test-file.nix) baseName)
      && baseName != "node_modules"
      && baseName != ".git"
      && baseName != ".paseo"
      && baseName != ".DS_Store";
  };

  nodejs = nodejs_26;

  # npmConfigHook requires the cache's lockfile to equal the source's, so
  # this puts the full lockfile next to the shared registry cache.
  npmDeps = runCommand "paseo-${version}-npm-deps" { } ''
    mkdir $out
    for entry in ${registryDeps}/* ${registryDeps}/.[!.]*; do
      [ -e "$entry" ] && ln -s "$entry" $out/
    done
    rm $out/package-lock.json
    cp ${../package-lock.json} $out/package-lock.json
  '';

  passthru = {
    inherit registryDeps registryLockfile;
  };

  # Prevent onnxruntime-node's install script from running during automatic
  # npm rebuild (it tries to download from api.nuget.org, which fails in the sandbox).
  # We manually rebuild only node-pty in buildPhase.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    python3 # for node-gyp (node-pty compilation)
    makeWrapper
  ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    libuv
    stdenv.cc.cc.lib # libstdc++ for sherpa-onnx prebuilt binaries
  ];

  # Don't use the default npm build hook — we need a custom build sequence
  dontNpmBuild = true;

  buildPhase = ''
    runHook preBuild

    # Apply repository patches without enabling unrelated install scripts.
    PATH="$PWD/node_modules/.bin:$PATH" node scripts/postinstall-patches.mjs

    # Rebuild only node-pty (native addon for terminal emulation). The sherpa
    # speech runtime ships prebuilt platform packages and is copied into the
    # daemon closure by scripts/trace-daemon.mjs.
    npm rebuild node-pty

    # Build all server packages in dependency order (defined in package.json)
    npm run build:server
    npm run build:daemon-web-ui

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Compute the daemon's runtime closure by static module-graph tracing
    # (@vercel/nft from supervisor-entrypoint.js, cli/dist/index.js, and the
    # forked terminal/speech worker processes) plus an explicit list of non-JS
    # assets read at runtime. The trace script is the single source of
    # truth for what the daemon needs at $out — auditable in plain JS, no
    # npm hoisting / .bin / workspace-symlink footguns.
    mkdir -p $out/lib/paseo
    node scripts/trace-daemon.mjs > daemon-files.txt

    while IFS= read -r path; do
      [ -z "$path" ] && continue
      mkdir -p "$out/lib/paseo/$(dirname "$path")"
      cp -a "$path" "$out/lib/paseo/$path"
    done < daemon-files.txt

    # Shell hooks invoke the retained CLI bin directly, without a system Node.
    patchShebangs --build "$out/lib/paseo"

    # Root package.json lets node resolve the workspace layout when the
    # CLI/server bin starts from $out.
    cp package.json $out/lib/paseo/

    # Web UI Assets
    cp -r packages/server/dist/server/web-ui $out/lib/paseo/packages/server/dist/server/

    # Create wrapper for the server entry point (for systemd / direct use)
    mkdir -p $out/bin
    # Keep Paseo's runtime mode separate from NODE_ENV, which belongs to spawned agents.
    makeWrapper ${nodejs}/bin/node $out/bin/paseo-server \
      --add-flags "$out/lib/paseo/packages/server/dist/scripts/supervisor-entrypoint.js" \
      --set PASEO_NODE_ENV production

    # Create wrapper for the CLI
    makeWrapper ${nodejs}/bin/node $out/bin/paseo \
      --add-flags "$out/lib/paseo/packages/cli/dist/index.js" \
      --set NODE_PATH "$out/lib/paseo/node_modules"

    runHook postInstall
  '';

  meta = {
    description = "Self-hosted daemon for Claude Code, Codex, and OpenCode";
    homepage = "https://github.com/getpaseo/paseo";
    license = lib.licenses.asl20;
    mainProgram = "paseo";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
