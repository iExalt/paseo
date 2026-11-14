#!/usr/bin/env node
// Root `npm run typecheck` imports these workspaces through their compiled `dist` declarations.
// In a fresh checkout they do not exist yet, and a typecheck run without them also caches its
// errors in each package's incremental `tsconfig.tsbuildinfo`, so they outlive the build.
// Build them first when any is missing; stale declarations stay the caller's job (CLAUDE.md).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
// Every package that `npm run build:server` builds.
const packages = ["protocol", "relay", "client", "highlight", "plugin", "server", "cli"];
const missing = packages.filter(
  (name) => !existsSync(path.join(repoRoot, "packages", name, "dist")),
);

if (missing.length > 0) {
  process.stderr.write(
    `[typecheck] no dist in ${missing.map((name) => `packages/${name}`).join(", ")}; running npm run build:server\n`,
  );
  const result = spawnSync("npm", ["run", "build:server"], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
