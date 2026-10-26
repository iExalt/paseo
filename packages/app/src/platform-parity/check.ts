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

type Runtime = "web" | "electron" | "ios" | "android";
type Variant = Runtime | "native" | "base";

/** Files each runtime tries, most specific first; the plain file is the fallback for all. */
const RESOLUTION: Record<Runtime, readonly Variant[]> = {
  web: ["web", "base"],
  electron: ["electron", "web", "base"],
  ios: ["ios", "native", "base"],
  android: ["android", "native", "base"],
};
const RUNTIMES = Object.keys(RESOLUTION) as Runtime[];

function variantOf(platform: string | undefined): Variant {
  return (platform as Variant | undefined) ?? "base";
}

/** Each module's files by variant, keyed by path under src without extension. */
function indexVariants(files: Iterable<string>): Map<string, Map<Variant, string>> {
  const variants = new Map<string, Map<Variant, string>>();
  for (const file of files) {
    const match = IGNORED_FILE.test(file) ? null : SOURCE_FILE.exec(file);
    if (!match) continue;
    const [, base, platform] = match;
    const entry = variants.get(base) ?? new Map<Variant, string>();
    entry.set(variantOf(platform), file);
    variants.set(base, entry);
  }
  return variants;
}

function resolveVariant(module: Map<Variant, string>, runtime: Runtime): Variant | undefined {
  return RESOLUTION[runtime].find((variant) => module.has(variant));
}

/** Runtimes that load a file: those whose resolution of its own module picks it. */
function loadingRuntimes(file: string, variants: Map<string, Map<Variant, string>>): Runtime[] {
  const match = IGNORED_FILE.test(file) ? null : SOURCE_FILE.exec(file);
  const own = match ? variants.get(match[1]) : undefined;
  if (!match || !own) return [];
  const variant = variantOf(match[2]);
  return RUNTIMES.filter((runtime) => resolveVariant(own, runtime) === variant);
}

/**
 * Imports that resolve to a platform variant without the imported name. Metro and Vitest
 * resolve a module's `.electron`/`.web`/`.native` file ahead of its plain file, so a name
 * the variant lacks is `undefined` at runtime there; TypeScript resolves the plain file and
 * cannot see it. Each importer is checked on every runtime that loads it, re-exports
 * included. Keys are POSIX paths relative to src.
 */
export function findMissingImports(facts: ReadonlyMap<string, SourceModuleFacts>): string[] {
  const variants = indexVariants(facts.keys());
  const problems = new Set<string>();
  for (const [file, { imports }] of facts) {
    const runtimes = loadingRuntimes(file, variants);
    for (const { module, names } of imports) {
      // `@/push-notifications` resolves to `push-notifications/index`.
      const target = variants.get(module) ?? variants.get(`${module}/index`);
      if (!target || target.size < 2) continue;
      for (const runtime of runtimes) {
        const variant = resolveVariant(target, runtime);
        const resolved = variant && target.get(variant);
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
