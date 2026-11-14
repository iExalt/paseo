import { parentPort } from "node:worker_threads";
import type { ZodIssue } from "zod";
import { compilePlugin, compileDirectoryPlugin } from "./compiler-build.js";
import { runPluginBuild } from "./preparation-build.js";
import { loadEsbuild } from "./compiler-esbuild.js";
import type { CompilerShutdown, CompilerTask } from "./compiler.js";

export type CompilerReply =
  | { kind: "log"; data: Record<string, unknown>; message: string }
  | { kind: "result"; value: unknown }
  | {
      kind: "error";
      error: Error;
      properties: Record<string, unknown>;
      issues?: ZodIssue[];
      errors?: unknown[];
      warnings?: unknown[];
    };

const port = parentPort!;
// The compiler owner serializes requests; the port queues the first request
// until this entrypoint has loaded, including in source/tsx development.
port.on("message", (task: CompilerTask | CompilerShutdown) => {
  if (task.kind === "shutdown") {
    void shutDown();
    return;
  }
  void run(task);
});

// Only this thread's event loop can reap esbuild's service child, and stop() resolves before
// the child exits. Exiting at once leaves a zombie, so give the child a moment to go first;
// esbuild exposes no handle to wait on. Closing the port then lets the worker exit.
const ESBUILD_EXIT_GRACE_MS = 500;

async function shutDown(): Promise<void> {
  try {
    await loadEsbuild().stop();
    await new Promise((resolve) => setTimeout(resolve, ESBUILD_EXIT_GRACE_MS));
  } finally {
    port.close();
  }
}

async function run(task: CompilerTask): Promise<void> {
  try {
    let value: unknown;
    switch (task.kind) {
      case "entries":
        value = await compilePlugin(task.entries);
        break;
      case "directory":
        value = await compileDirectoryPlugin(task.directory, task.version, task.builtinId);
        break;
      case "prepare":
        await runPluginBuild(
          task.directory,
          task.commands,
          {
            info: (data, message) =>
              port.postMessage({ kind: "log", data, message } satisfies CompilerReply),
          },
          task.environment,
        );
        break;
    }
    port.postMessage({ kind: "result", value } satisfies CompilerReply);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    port.postMessage({
      kind: "error",
      error,
      // Error cloning drops own metadata such as filesystem code/path. Zod's
      // readonly issues are reconstructed separately by the compiler owner.
      properties: Object.fromEntries(Object.entries(error).filter(([key]) => key !== "issues")),
      ...("issues" in error ? { issues: error.issues as ZodIssue[] } : {}),
      ...("errors" in error ? { errors: error.errors as unknown[] } : {}),
      ...("warnings" in error ? { warnings: error.warnings as unknown[] } : {}),
    } satisfies CompilerReply);
  }
}
