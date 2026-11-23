import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function cursorProjectDirectories(cwd: string): Promise<string[]> {
  const directories = [cwd];
  for (let directory = cwd; ; directory = dirname(directory)) {
    const marker = await stat(join(directory, ".git")).catch(() => null);
    if (marker?.isFile() || marker?.isDirectory()) return directories.toReversed();
    const parent = dirname(directory);
    if (parent === directory) return [cwd];
    directories.push(parent);
  }
}
