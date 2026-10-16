/** Chunks of docs/PLATFORM_PARITY_PLAN.md that own a gap. */
export type ParityChunk = "B2" | "C1" | "C2" | "C3" | "D1" | "E1" | "E2" | "E3" | "F1" | "F2";

export type ParityEntry =
  /** The same feature, implemented per platform. */
  | { kind: "equivalent"; note?: string }
  /** Mobile lacks the feature until the named chunk lands. */
  | { kind: "gap"; chunk: ParityChunk; reason: string }
  /** Mobile lacks the feature on purpose. */
  | { kind: "deliberate"; reason: string };

export interface ParityManifest {
  /** Keyed by the module path under src, without platform suffix or extension. */
  splitModules: Record<string, ParityEntry>;
  /** Keyed by settings section id. */
  settingsSections: Record<string, ParityEntry>;
  /** Shared files that gate a feature at runtime, keyed by path under src. */
  runtimeGates: Record<string, ParityEntry & { kind: "gap" | "deliberate" }>;
}

export interface ParityTree {
  /** POSIX paths relative to src. */
  files: readonly string[];
  /** Settings section ids that some runtime hides. */
  gatedSettingsSections: readonly string[];
}

const SOURCE_FILE = /^(.*?)(?:\.(native|ios|android|web|electron))?\.(ts|tsx)$/;
const IGNORED_FILE = /\.(test|spec)\.tsx?$|\.d\.ts$/;
const WEB_PLATFORMS = new Set(["web", "electron"]);
const NATIVE_PLATFORMS = new Set(["native", "ios", "android"]);

function platformGroup(platform: string | undefined): "web" | "native" | "base" {
  if (platform && WEB_PLATFORMS.has(platform)) return "web";
  if (platform && NATIVE_PLATFORMS.has(platform)) return "native";
  return "base";
}

/**
 * Modules Metro resolves to different files per platform: any two of a
 * `.web`/`.electron` file, a `.native`/`.ios`/`.android` file and a plain file.
 */
export function findSplitModules(files: readonly string[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const file of files) {
    if (IGNORED_FILE.test(file)) continue;
    const match = SOURCE_FILE.exec(file);
    if (!match) continue;
    const [, base, platform] = match;
    const entry = groups.get(base) ?? new Set<string>();
    entry.add(platformGroup(platform));
    groups.set(base, entry);
  }
  return [...groups]
    .filter(([, entry]) => entry.size > 1)
    .map(([base]) => base)
    .sort();
}

function entryProblem(entry: ParityEntry): string | null {
  if (entry.kind === "equivalent") return null;
  return entry.reason.trim() === "" ? "has no reason" : null;
}

/** Every way the tree and the manifest disagree, as readable messages. */
export function checkParity(tree: ParityTree, manifest: ParityManifest): string[] {
  const problems: string[] = [];
  const files = new Set(tree.files);
  const splitModules = new Set(findSplitModules(tree.files));
  const gated = new Set(tree.gatedSettingsSections);

  for (const module of splitModules) {
    if (!(module in manifest.splitModules)) {
      problems.push(`split module ${module} is not classified in the parity manifest`);
    }
  }
  for (const [module, entry] of Object.entries(manifest.splitModules)) {
    if (!splitModules.has(module)) problems.push(`split module ${module} is no longer split`);
    const problem = entryProblem(entry);
    if (problem) problems.push(`split module ${module} ${problem}`);
  }
  for (const section of gated) {
    if (!(section in manifest.settingsSections)) {
      problems.push(`settings section ${section} is gated but not classified`);
    }
  }
  for (const [section, entry] of Object.entries(manifest.settingsSections)) {
    if (!gated.has(section)) problems.push(`settings section ${section} is no longer gated`);
    const problem = entryProblem(entry);
    if (problem) problems.push(`settings section ${section} ${problem}`);
  }
  for (const [file, entry] of Object.entries(manifest.runtimeGates)) {
    if (!files.has(file)) problems.push(`runtime gate ${file} no longer exists`);
    const problem = entryProblem(entry);
    if (problem) problems.push(`runtime gate ${file} ${problem}`);
  }
  return problems;
}
