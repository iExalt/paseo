{
  description = "Paseo - self-hosted daemon for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Unstable no longer supports Intel macOS; retain its supported stable lane.
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import (if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs) {
        inherit system;
        overlays = [ (final: prev: import ./nix/runtime-overrides.nix { inherit final prev; }) ];
      };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          paseo = pkgs.callPackage ./nix/package.nix { };
          # Keep Electron's numeric build version independent of flake source
          # transport. The authenticated closure manifest records the immutable
          # source revision separately; revCount is unavailable for GitHub
          # archive inputs and made the same commit evaluate to different paths.
          desktopBuildVersion = builtins.head (builtins.match "^([0-9]+\\.[0-9]+\\.[0-9]+)([-+].*)?$" paseo.version);
        in
        {
          default = paseo;
          paseo = paseo;
          desktop = pkgs.callPackage ./nix/desktop-package.nix {
            inherit paseo;
            buildVersion = desktopBuildVersion;
          };
        }
      );

      nixosModules.default = self.nixosModules.paseo;
      nixosModules.paseo =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.paseo.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_26
              pkgs.python3
            ];
          };
        }
      );
    };
}
