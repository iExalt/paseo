// paseo-v0.18.0 asset fixture plus the required signed desktop sidecars: `gh release view paseo-v0.18.0 --json assets` and its index's deltas.
    "paseo-desktop-manifest.json",
    "paseo-desktop-manifest.sig",
test("the catalog preserves published artifact names and requires desktop sidecars", () => {
  for (const name of ["paseo-desktop-manifest.json", "paseo-desktop-manifest.sig"])
    assert.throws(() => expectedAssets(version, without(name), index(deltas)), /asset set/);
