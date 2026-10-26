/** Chunks of docs/PLATFORM_PARITY_PLAN.md that own a gap. */
export type ParityChunk = "B2" | "C3" | "E1" | "E2" | "E3" | "F1" | "F2";

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

export interface SourceModuleFacts {
  /** Runtime (non-type) export names. */
  exports: readonly string[];
  /** Named runtime imports, keyed by the imported module's path under src without extension. */
  imports: readonly { module: string; names: readonly string[] }[];
}

const PLATFORM_GROUPS = ["web", "native"] as const;

type PlatformGroup = "web" | "native" | "base";

/** Each module's files by platform group; `.web` wins over `.electron`, which only desktop loads. */
function indexVariants(files: Iterable<string>): Map<string, Map<PlatformGroup, string>> {
  const variants = new Map<string, Map<PlatformGroup, string>>();
  for (const file of files) {
    const match = IGNORED_FILE.test(file) ? null : SOURCE_FILE.exec(file);
    if (!match) continue;
    const [, base, platform] = match;
    const entry = variants.get(base) ?? new Map<PlatformGroup, string>();
    const group = platformGroup(platform);
    if (group !== "web" || platform === "web" || !entry.has("web")) entry.set(group, file);
    variants.set(base, entry);
  }
  return variants;
}

/** Platforms that load a file: its own group, or for a plain file each group its module lacks. */
function loadingPlatforms(
  file: string,
  variants: Map<string, Map<PlatformGroup, string>>,
): ("web" | "native")[] {
  const match = SOURCE_FILE.exec(file);
  if (!match || IGNORED_FILE.test(file)) return [];
  const [, base, platform] = match;
  const group = platformGroup(platform);
  if (group !== "base") return [group];
  const own = variants.get(base);
  return PLATFORM_GROUPS.filter((candidate) => !own?.has(candidate));
}

/**
 * Imports that resolve to a platform variant without the imported name. Metro and Vitest
 * resolve a module's `.web`/`.native` file ahead of its plain file, so a name the variant
 * lacks is `undefined` at runtime on that platform; TypeScript resolves the plain file and
 * cannot see it. An importer is checked on the platforms that load it: a `.web` file on
 * web, a plain file on each platform its own module has no variant for. Keys are POSIX
 * paths relative to src.
 */
export function findMissingImports(facts: ReadonlyMap<string, SourceModuleFacts>): string[] {
  const variants = indexVariants(facts.keys());
  const problems = new Set<string>();
  for (const [file, { imports }] of facts) {
    const platforms = loadingPlatforms(file, variants);
    for (const { module, names } of imports) {
      const target = variants.get(module);
      if (!target || target.size < 2) continue;
      for (const candidate of platforms) {
        const resolved = target.get(candidate) ?? target.get("base");
        if (!resolved) continue;
        const exported = new Set(facts.get(resolved)?.exports);
        const missing = names.filter((name) => !exported.has(name));
        if (missing.length > 0) {
          problems.add(
            `${file} imports ${missing.join(", ")} from ${resolved}, which does not export it`,
          );
        }
      }
    }
  }
  return [...problems].sort();
}
