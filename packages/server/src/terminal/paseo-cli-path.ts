import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const PASEO_CLI_BIN_ENTRY = "@getpaseo/cli/bin/paseo";

function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolvePaseoCliExecutablePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const configuredCli = env.PASEO_CLI?.trim();
  if (configuredCli) {
    return resolve(configuredCli);
  }

  let cliEntrypoint: string;
  try {
    cliEntrypoint = require.resolve(PASEO_CLI_BIN_ENTRY);
  } catch {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolvePaseoCliShim(npmBinDir);
    if (shim) return shim;
  }

  return externalCliEntrypoint;
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (resolvePaseoCliShim(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePaseoCliShim(binDir: string): string | null {
  const names = process.platform === "win32" ? ["paseo.cmd", "paseo.exe", "paseo"] : ["paseo"];
  for (const name of names) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
