import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rawLimit = 2 * 1024 ** 3;
export function maySave(env, bytes) {
  return (
    env.GITHUB_EVENT_NAME === "push" &&
    env.GITHUB_REPOSITORY === "iExalt/paseo" &&
    env.GITHUB_REF === "refs/heads/dev" &&
    Number.isSafeInteger(bytes) &&
    bytes > 0 &&
    bytes <= rawLimit
  );
}
export function directoryBytes(directory) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error("Cache must not contain symbolic links");
  return stat.isDirectory()
    ? readdirSync(directory).reduce(
        (bytes, name) => bytes + directoryBytes(join(directory, name)),
        0,
      )
    : stat.size;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (process.argv[2] === "key") {
    const npm = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    if (process.version !== "v26.11.0" || npm !== "11.20.0")
      throw new Error("Unexpected routine toolchain");
    const prefix = `routine-npm-v1-${process.platform}-${process.arch}-${process.version}-${npm}-`;
    const lock = createHash("sha256").update(readFileSync("package-lock.json")).digest("hex");
    output("prefix", prefix);
    output("key", `${prefix}${lock}`);
  } else if (process.argv[2] === "size") {
    const bytes = directoryBytes(join(process.env.npm_config_cache, "_cacache"));
    output("save", maySave(process.env, bytes));
    console.log(`npm cache raw bytes: ${bytes}; per-entry save ceiling: ${rawLimit}`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `npm download cache: ${bytes} raw bytes (compressed upload size appears in cache logs). Repo ceiling remains 10 GB.\n`,
    );
  } else throw new Error("Expected key or size");
}
