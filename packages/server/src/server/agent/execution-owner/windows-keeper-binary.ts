import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const executableName = "paseo-execution-owner-x64.exe";

async function bundledKeeper(): Promise<Buffer> {
  const local = fileURLToPath(new URL(executableName, import.meta.url));
  try {
    return await readFile(local);
  } catch (error) {
    if (!process.versions.electron || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    const resources = join(dirname(process.execPath), "resources");
    return readFile(join(resources, "execution-owner", executableName));
  }
}

async function cachedKeeperMatches(path: string, expected: Buffer): Promise<boolean> {
  const entry = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
  if (!entry) return false;
  if (!entry.isFile() || !expected.equals(await readFile(path))) {
    throw new Error("The cached Windows execution owner does not match the installed helper.");
  }
  return true;
}

/** Run a copy so an owner surviving daemon death does not hold the install open. */
export async function stageWindowsKeeper(): Promise<string> {
  const bytes = await bundledKeeper();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Paseo",
    "execution-owner",
  );
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `keeper-${digest}.exe`);
  if (await cachedKeeperMatches(destination, bytes)) return destination;
  const scratch = await mkdtemp(join(directory, ".keeper-"));
  try {
    const staged = join(scratch, executableName);
    await writeFile(staged, bytes, { flush: true });
    try {
      // A hard link publishes the complete copy and cannot replace a running keeper.
      await link(staged, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await cachedKeeperMatches(destination, bytes))) {
      throw new Error("The Windows execution owner copy was not published.");
    }
    return destination;
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}
