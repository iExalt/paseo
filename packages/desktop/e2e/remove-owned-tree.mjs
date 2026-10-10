import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Only use for a disposable tree owned by this test after its processes stop.
export async function removeOwnedTree(root) {
  async function makeDirectoriesWritable(directory) {
    const entry = await lstat(directory);
    if (!entry.isDirectory()) return;
    await chmod(directory, (entry.mode & 0o7777) | 0o700);
    for (const name of await readdir(directory)) {
      await makeDirectoriesWritable(join(directory, name));
    }
  }
  await makeDirectoriesWritable(root);
  await rm(root, { recursive: true, force: true });
}
