{ final, prev }:
let
  # Node comes from the pinned nixpkgs so the binary cache serves it; only
  # Electron is pinned to the project runtime.
  electronVersion = "45.5.0";
  electronArchives = {
    aarch64-darwin = {
      tag = "darwin-arm64";
      sha256 = "00d345b061064de7e6e2c02bec7ffa1adb7ef488fe4b673bd8ad3e059a182245";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      sha256 = "9ce4b0e25ce95e743b2d8f04ebfbfd76027060ff8b47829de22334fbdbdd4cc4";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      sha256 = "f2bd21b4167dbf0d27968347127afa6703161fdb513b1f3c61da5de9289cac0a";
    };
    x86_64-linux = {
      tag = "linux-x64";
      sha256 = "36b44cd0c3d355ee74557bea2353e4539f96e1a09733a52a052bd093134a6142";
    };
  };
  archive = electronArchives.${prev.stdenv.hostPlatform.system};
in
{
  # Match the nixpkgs 1.6.0 recipe for the updater without replacing libzstd elsewhere.
  paseoUpdateZstd = prev.zstd.overrideAttrs (finalAttrs: old: {
    version = "1.6.0";
    src = prev.fetchFromGitHub {
      owner = "meta";
      repo = "zstd";
      tag = "v${finalAttrs.version}";
      hash = "sha256-bzIcrgp7uYeJ+LEv6Nb9Nd41jGfJvUvDZ0nxQBu5Tvo=";
    };
    patches = builtins.filter (patch: !(prev.lib.hasSuffix "man-fix.patch" (toString patch))) old.patches;
    postPatch = builtins.replaceStrings
      [ "build/cmake/CMakeLists.txt" "You need to build static library to build tests" "--replace " ]
      [ "build/cmake/CMakeModules/ZstdBuild.cmake" "Static library required to build test suite" "--replace-fail " ]
      old.postPatch;
  });

  electron = prev.electron_45-bin.overrideAttrs (old: {
    version = electronVersion;
    src = prev.fetchurl {
      url = "https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-${archive.tag}.zip";
      inherit (archive) sha256;
    };
    passthru = old.passthru // {
      headers = prev.fetchzip {
        name = "electron-${electronVersion}-headers";
        url = "https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz";
        hash = "sha256-+b2WCfYnoTe3YnW1g0WAwx21jCCPjH1gYl5xAV6LDS8=";
      };
    };
    meta = old.meta // { platforms = builtins.attrNames electronArchives; };
  });
}
