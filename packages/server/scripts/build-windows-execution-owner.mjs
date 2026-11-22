import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.platform === "win32" && process.arch === "x64") {
  const destination = new URL("../dist/server/server/agent/execution-owner/", import.meta.url);
  const { windowsJobSource } = await import(new URL("windows-job-script.js", destination));
  const directory = fileURLToPath(destination);
  const temporary = await mkdtemp(join(directory, ".keeper-build-"));
  const compiler = join(
    process.env.SystemRoot,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  try {
    const source = join(temporary, "keeper.cs");
    const executable = join(temporary, "paseo-execution-owner-x64.exe");
    await writeFile(source, windowsJobSource);
    await promisify(execFile)(
      compiler,
      ["/nologo", "/target:exe", "/platform:x64", "/out:" + executable, source],
      { timeout: 20_000, windowsHide: true },
    );
    await rename(executable, fileURLToPath(new URL("paseo-execution-owner-x64.exe", destination)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
