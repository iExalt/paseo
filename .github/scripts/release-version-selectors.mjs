// Enumerate only fork-owned version fields. External dependency versions are
// deliberately absent, including when they happen to equal the fork version.
export function releaseVersionSelectors(packages) {
  const names = new Set(packages.map(([, value]) => value.name));
  const selectors = [];
  const add = (path, keys) =>
    selectors.push({
      type: "json",
      path,
      jsonpath: "$" + keys.map((key) => `[${JSON.stringify(key)}]`).join(""),
    });
  add(".github/fork-release.json", ["version"]);
  for (const [directory, pkg] of packages) {
    if (directory) add(`${directory}/package.json`, ["version"]);
    add("package-lock.json", ["packages", directory, "version"]);
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys(pkg[section] ?? {}).sort()) {
        if (names.has(name) && !pkg.private) {
          add(directory ? `${directory}/package.json` : "package.json", [section, name]);
          add("package-lock.json", ["packages", directory, section, name]);
        }
      }
    }
  }
  return selectors;
}
