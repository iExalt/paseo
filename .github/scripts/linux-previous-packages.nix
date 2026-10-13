# Rebuild the sanitized 0.1.0 predecessor without changing its packaging.
# The exact expression and its digest are retained with the native upgrade proof.
{ source }:
let
  flake = builtins.getFlake source;
  packages = flake.packages.${builtins.currentSystem};
in {
  daemon = packages.paseo;
  desktop = packages.desktop;
}
