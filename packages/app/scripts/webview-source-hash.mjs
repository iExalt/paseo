import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** SHA-256 over each app-relative path and its contents, in the order given. */
export async function hashWebViewSources(appRoot, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(appRoot, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
