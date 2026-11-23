import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Logger } from "pino";
import { compareBuild, parse as parseVersion } from "semver";
import { parse as parseToml } from "smol-toml";

const manifestPaths = [".codex-plugin", ".claude-plugin", ".cursor-plugin"];
const pluginNamePattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i;
const marketplacePattern = /^[a-z0-9_-]+$/i;
const versionSegment = /^[a-z0-9._+-]+$/i;

export type CodexSkillRule = { enabled: boolean } & (
  | { name: string; path?: never }
  | { path: string; name?: never }
);

type ReadMetadata = (path: string, boundary?: string) => Promise<string | null>;

interface ProfileFilesystem {
  read: ReadMetadata;
  resolveDirectory: (path: string) => Promise<string | null>;
}

interface PluginSkillRoot {
  path: string;
  boundary: string;
  pluginName: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function configRules(config: Record<string, unknown>, directory: string): CodexSkillRule[] {
  const settings = record(config.skills)?.config;
  if (!Array.isArray(settings)) return [];
  const rules: CodexSkillRule[] = [];
  for (const input of settings) {
    const rule = record(input);
    if (typeof rule?.enabled !== "boolean") continue;
    const { enabled, name, path } = rule;
    if (typeof name === "string" && name.trim() && path === undefined) {
      rules.push({ enabled, name: name.trim() });
    }
    if (typeof path === "string" && path.trim() && name === undefined) {
      rules.push({ enabled, path: resolve(directory, path) });
    }
  }
  return rules;
}

// Codex e0a6d05 (Apache-2.0), core-plugin-common/src/installed.rs:
// use semantic ordering for pairs of SemVer versions and lexical ordering otherwise.
function compareVersions(left: string, right: string): number {
  const a = /^\d/.test(left) ? parseVersion(left) : null;
  const b = /^\d/.test(right) ? parseVersion(right) : null;
  if (a && b) return compareBuild(a, b);
  return Number(left > right) - Number(left < right);
}

async function installedPluginRoot(
  path: string,
  files: ProfileFilesystem,
): Promise<string | undefined> {
  const base = await files.resolveDirectory(path);
  if (!base) return;
  const directories = (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && versionSegment.test(entry.name))
    .map((entry) => entry.name);
  const version = directories.includes("local")
    ? "local"
    : directories.sort(compareVersions).at(-1);
  return version ? join(base, version) : undefined;
}

async function readPluginManifest(root: string, read: ReadMetadata) {
  for (const directory of manifestPaths) {
    const path = join(root, directory, "plugin.json");
    const parent = await lstat(dirname(path)).catch(() => null);
    if (!parent) continue;
    if (!parent.isDirectory()) return;
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    if (!info.isFile()) return;
    const data = await read(path, root);
    if (!data) return;
    try {
      return record(JSON.parse(data));
    } catch {
      return;
    }
  }
}

function manifestSkillPaths(value: unknown, root: string): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const roots = entries.flatMap((path: unknown) => {
    if (
      typeof path !== "string" ||
      !path.startsWith("./") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").includes("..")
    )
      return [];
    return [join(root, path)];
  });
  return roots.length ? roots : [join(root, "skills")];
}

export async function readCodexSkillProfile(
  directory: string,
  files: ProfileFilesystem,
  logger?: Pick<Logger, "warn">,
): Promise<{ rules: CodexSkillRule[]; roots: PluginSkillRoot[]; inputs: string[] }> {
  const configFile = join(directory, "config.toml");
  const inputs = [configFile];
  const roots: PluginSkillRoot[] = [];
  const empty = { rules: [], roots, inputs };
  const data = await files.read(configFile);
  if (data === null) return empty;
  let config: Record<string, unknown>;
  try {
    config = parseToml(data);
  } catch {
    logger?.warn("Could not parse Codex config while discovering Cursor SDK skills");
    return empty;
  }

  for (const [key, settings] of Object.entries(record(config.plugins) ?? {})) {
    const segments = key.split("@");
    if (segments.length !== 2) continue;
    const [plugin, marketplace] = segments;
    if (!pluginNamePattern.test(plugin) || !marketplacePattern.test(marketplace)) continue;
    const pluginConfig = record(settings);
    if (!pluginConfig || pluginConfig.enabled === false) continue;

    const configuredBase = join(directory, "plugins", "cache", marketplace, plugin);
    inputs.push(configuredBase);
    const boundary = await installedPluginRoot(configuredBase, files);
    if (!boundary) {
      logger?.warn({ plugin: key }, "Configured Codex plugin is missing from the local cache");
      continue;
    }
    for (const manifestDirectory of manifestPaths) {
      const parent = join(boundary, manifestDirectory);
      inputs.push(parent, join(parent, "plugin.json"));
    }
    const manifest = await readPluginManifest(boundary, files.read);
    if (!manifest) continue;
    const pluginName =
      typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : plugin;
    for (const path of manifestSkillPaths(manifest.skills, boundary)) {
      roots.push({ path, boundary, pluginName });
    }
  }
  return { rules: configRules(config, directory), roots, inputs };
}
