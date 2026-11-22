import type { SDKModel } from "@cursor/sdk";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const messages = {
  missing_credentials:
    "Sign in to Cursor SDK in host settings or configure CURSOR_API_KEY on the host.",
  missing_helper: "The Cursor SDK native helper is missing or cannot run on this host.",
  invalid_key: "Cursor rejected this host’s API key. Check CURSOR_API_KEY or sign in again.",
  catalog_forbidden: "This Cursor credential does not have access to the model catalog.",
  catalog_unavailable: "Could not reach the Cursor SDK model catalog. Try refreshing models.",
} as const;

export type CursorSdkAvailabilityCode = keyof typeof messages;

export class CursorSdkAvailabilityError extends Error {
  constructor(readonly code: CursorSdkAvailabilityCode) {
    super(messages[code]);
  }
}

export async function verifyCursorSdkHelper(
  sdkUrl?: string,
  override = process.env.CURSOR_RIPGREP_PATH,
): Promise<void> {
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const platformPackage = "sdk-" + process.platform + "-" + process.arch;
  try {
    const sdkPath = fileURLToPath(sdkUrl ?? import.meta.resolve("@cursor/sdk"));
    const asar = sdkPath.indexOf(sep + "app.asar" + sep);
    let executable: string;
    if (override && isAbsolute(override)) {
      executable = override;
    } else if (asar !== -1) {
      // Electron ships native helpers in the physical Resources directory.
      executable = join(
        sdkPath.slice(0, asar),
        "node_modules",
        "@cursor",
        platformPackage,
        "bin",
        binary,
      );
    } else {
      const manifest = createRequire(sdkPath).resolve(
        "@cursor/" + platformPackage + "/package.json",
      );
      executable = join(dirname(manifest), "bin", binary);
    }

    await access(executable, constants.X_OK);
    if ((await stat(executable)).isFile()) return;
  } catch {
    // Publish only the stable diagnostic. Host paths and raw SDK errors can contain private data.
  }
  throw new CursorSdkAvailabilityError("missing_helper");
}

type CatalogWorkerResult = { models: SDKModel[] } | { status?: number };

function catalogFailure(status?: number): CursorSdkAvailabilityError {
  if (status === 401) return new CursorSdkAvailabilityError("invalid_key");
  if (status === 403) return new CursorSdkAvailabilityError("catalog_forbidden");
  return new CursorSdkAvailabilityError("catalog_unavailable");
}

// Cursor.models.list does not accept an AbortSignal. Terminating the worker closes its
// requests before a timed-out provider refresh releases its concurrency slot.
export async function listCursorSdkModels(
  apiKey: string,
  signal: AbortSignal,
  sdkUrl = import.meta.resolve("@cursor/sdk"),
): Promise<SDKModel[]> {
  signal.throwIfAborted();
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { Cursor, CursorSdkError } = await import(workerData.sdkUrl);
      try {
        const models = await Cursor.models.list({ apiKey: workerData.apiKey });
        parentPort.postMessage({ models });
      } catch (error) {
        const status = CursorSdkError && error instanceof CursorSdkError ? error.status : undefined;
        parentPort.postMessage({ status });
      }
    })();`,
    {
      eval: true,
      execArgv: [],
      stdout: true,
      stderr: true,
      workerData: { apiKey, sdkUrl },
    },
  );
  worker.stdout.resume();
  worker.stderr.resume();

  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<SDKModel[]>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (result: CatalogWorkerResult) => {
        if ("models" in result) resolve(result.models);
        else reject(catalogFailure(result.status));
      });
      worker.once("error", () => reject(catalogFailure()));
      worker.once("exit", () => reject(catalogFailure()));
    });
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    await worker.terminate();
  }
}
