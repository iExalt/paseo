import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * SHA-256 over each app-relative source path and its contents, then each bundled
 * package's `name@version`, in the order given.
 */
export async function hashWebViewSources(appRoot, files, packages) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(appRoot, file)));
    hash.update("\0");
  }
  for (const dir of packages) {
    const manifest = JSON.parse(await fs.readFile(path.join(appRoot, dir, "package.json"), "utf8"));
    hash.update(`${manifest.name}@${manifest.version}\0`);
  }
  return hash.digest("hex");
}
