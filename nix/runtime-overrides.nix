{ final, prev }:
let
  # Keep the pinned nixpkgs build setup while matching the project runtimes.
  nodeVersion = "26.11.0";
  electronVersion = "44.6.0";
  electronArchives = {
    aarch64-darwin = {
      tag = "darwin-arm64";
      sha256 = "023a69ab3a2e8fac0a62746c2aaaf42f637b7ab07b8d78fb64f00c48e01fef8c";
    };
    x86_64-darwin = {
      tag = "darwin-x64";
      sha256 = "25076a029742bb6bc4a1110db208658837c9febb0688a6f34acddcc645bdfb45";
    };
    aarch64-linux = {
      tag = "linux-arm64";
      sha256 = "9298bc6fb86528e79fbc643aaefe4e195e58153c40cddcfedec52a59ce114c79";
    };
    x86_64-linux = {
      tag = "linux-x64";
      sha256 = "20cafbe96e0ab8ad95cd31804acd683142b361f9e25f1595aecf67177d0a8915";
    };
  };
  archive = electronArchives.${prev.stdenv.hostPlatform.system};
in
{
  nodejs-slim_26 = prev.nodejs-slim_26.overrideAttrs (old: {
    version = nodeVersion;
    src = prev.fetchurl {
      url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}.tar.xz";
      sha256 = "aaad9242704524109e88d48be7bb7b7943486d931e740a352c02e97e107f18c9";
    };
    # Node 26.11 enables V8's system-ICU path without private ICU headers.
    patches = builtins.filter
      (patch: builtins.baseNameOf (toString patch) != "fix-temporal-integration-with-shared-icu.patch")
      old.patches
      ++ prev.lib.optionals prev.stdenv.hostPlatform.isDarwin [ ./node-dns-lookupservice-test.patch ];
    passthru = old.passthru // {
      tests = old.passthru.tests // {
        version = prev.testers.testVersion {
          package = final.nodejs-slim_26;
          version = "v${nodeVersion}";
        };
      };
    };
    meta = old.meta // { changelog = "https://github.com/nodejs/node/releases/tag/v${nodeVersion}"; };
  });
  nodejs_26 = prev.nodejs_26.override { nodejs-slim = final.nodejs-slim_26; };

  electron = prev.electron_44-bin.overrideAttrs (old: {
    version = electronVersion;
    src = prev.fetchurl {
      url = "https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-${archive.tag}.zip";
      inherit (archive) sha256;
    };
    passthru = old.passthru // {
      headers = prev.fetchzip {
        name = "electron-${electronVersion}-headers";
        url = "https://artifacts.electronjs.org/headers/dist/v${electronVersion}/node-v${electronVersion}-headers.tar.gz";
        hash = "sha256-huHpL8ku9K4xiEKKK+yeh+am+9mZEeWmfO55qZdkIcg=";
      };
    };
    meta = old.meta // { platforms = builtins.attrNames electronArchives; };
  });
}
