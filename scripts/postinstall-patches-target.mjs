const serverPackagePath = "packages/server/node_modules/@opencode-ai/sdk";
const rootPackagePath = "node_modules/@opencode-ai/sdk";

export function resolveOpenCodePatchTarget(exists) {
  if (exists(serverPackagePath)) {
    return {
      nodeModulesPath: serverPackagePath,
      patchPrefix: "@opencode-ai+sdk+",
      cwd: "packages/server",
    };
  }

  if (exists(rootPackagePath)) {
    return {
      nodeModulesPath: rootPackagePath,
      patchPrefix: "@opencode-ai+sdk+",
      cwd: ".",
    };
  }

  return null;
}
