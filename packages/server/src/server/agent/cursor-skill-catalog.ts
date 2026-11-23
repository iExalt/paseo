import type { CursorSkillReference } from "@getpaseo/protocol/messages";
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse as parsePath, relative, resolve } from "node:path";
import { parse } from "yaml";
import { areEquivalentPaths, isPathInsideRoot } from "../../utils/path.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { cursorProjectDirectories } from "./cursor-project-directories.js";

const maxSkillBytes = 64 * 1024;
const maxSelectedBytes = 128 * 1024;
const maxDepth = 6;
const maxDirectories = 2_000;
const maxEntries = 20_000;
const pathSeparator = process.platform === "win32" ? /[\\/]/ : "/";
const skillName = /^[a-z][a-z0-9-]{0,63}$/;

export interface CursorSkillRoot {
  path: string;
  boundary: string;
  scope: "workspace" | "user";
  excludedRoots?: readonly string[];
  excludedDirectoryIds?: ReadonlySet<string>;
}

export interface ResolvedCursorSkill {
  name: string;
  reference: CursorSkillReference;
  description: string;
  path: string;
  instructions: string;
}

export function isAllowedSkillPath(
  source: Pick<CursorSkillRoot, "boundary" | "excludedRoots">,
  path: string,
): boolean {
  return (
    isPathInsideRoot(source.boundary, path) &&
    !source.excludedRoots?.some((excluded) => isPathInsideRoot(excluded, path))
  );
}

export interface CursorSkillTarget {
  cwd: string;
  workspaceId?: string;
  skillScope?: "user";
}

export function isExcludedCursorPath(
  source: Pick<CursorSkillRoot, "excludedRoots">,
  path: string,
): boolean {
  return source.excludedRoots?.some((root) => isPathInsideRoot(root, path)) ?? false;
}

export function cursorCodexHome(home = homedir()): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(home, ".codex");
}

type CursorWorkspace = Pick<PersistedWorkspaceRecord, "cwd" | "workspaceId" | "untrustedSource">;

async function cursorWorkspacePaths(workspaces: readonly CursorWorkspace[]) {
  const registrations = await Promise.all(
    workspaces.map(async (workspace) => {
      const canonical = await realpath(workspace.cwd).catch(() => null);
      const directory =
        workspace.untrustedSource && canonical
          ? await stat(canonical, { bigint: true }).catch(() => null)
          : null;
      return { workspace, canonical, directory };
    }),
  );
  const excludedRoots: string[] = [];
  const excludedDirectoryIds = new Set<string>();
  for (const { workspace, canonical, directory } of registrations) {
    if (!workspace.untrustedSource) continue;
    excludedRoots.push(workspace.cwd);
    if (canonical) excludedRoots.push(canonical);
    if (directory?.isDirectory()) excludedDirectoryIds.add(directoryId(directory));
  }
  const exclusions = { excludedRoots, excludedDirectoryIds };
  return { registrations, exclusions };
}

export async function cursorSkillRoots(
  target: CursorSkillTarget,
  workspaceRegistry?: {
    listActive(): Promise<readonly CursorWorkspace[]>;
  },
  userHome = homedir(),
): Promise<CursorSkillRoot[]> {
  const [home, workspaces] = await Promise.all([
    realpath(userHome).catch(() => null),
    workspaceRegistry?.listActive() ?? [],
  ]);
  const { registrations, exclusions } = await cursorWorkspacePaths(workspaces);
  const cwd = await resolveCursorDiscoveryPath(exclusions, target.cwd);
  const registered = registrations.filter(({ workspace }) =>
    target.workspaceId
      ? workspace.workspaceId === target.workspaceId
      : isPathInsideRoot(workspace.cwd, target.cwd),
  );
  const registrationIsValid =
    (!target.workspaceId || registered.length > 0) &&
    registered.every(
      ({ workspace, canonical }) =>
        canonical &&
        cwd &&
        areEquivalentPaths(workspace.cwd, canonical) &&
        isPathInsideRoot(canonical, cwd),
    );
  const sources: CursorSkillRoot[] = [];
  if (
    target.skillScope !== "user" &&
    cwd &&
    registrationIsValid &&
    !isExcludedCursorPath(exclusions, target.cwd)
  ) {
    const workspaceBoundary = registered
      .map(({ canonical }) => canonical!)
      .sort((left, right) => right.length - left.length)[0];
    for (const projectDirectory of (await cursorProjectDirectories(cwd)).toReversed()) {
      if (isExcludedCursorPath(exclusions, projectDirectory)) continue;
      const boundary =
        workspaceBoundary && isPathInsideRoot(workspaceBoundary, projectDirectory)
          ? workspaceBoundary
          : projectDirectory;
      for (const directory of [".agents", ".codex", ".cursor"]) {
        sources.push({
          path: join(projectDirectory, directory, "skills"),
          boundary,
          scope: "workspace",
          ...exclusions,
        });
      }
    }
  }
  if (home) {
    const codex = cursorCodexHome(home);
    const codexBoundary = isPathInsideRoot(home, codex) ? home : dirname(codex);
    sources.push({
      path: join(codex, "skills"),
      boundary: codexBoundary,
      scope: "user",
      ...exclusions,
    });
    for (const directory of [".agents", ".cursor"]) {
      sources.push({
        path: join(home, directory, "skills"),
        boundary: home,
        scope: "user",
        ...exclusions,
      });
    }
  }
  return sources;
}

function directoryId({ dev, ino }: { dev: bigint; ino: bigint }): string {
  return String(dev) + ":" + String(ino);
}

export async function resolveCursorDiscoveryPath(
  source: Pick<CursorSkillRoot, "excludedRoots" | "excludedDirectoryIds">,
  path: string,
): Promise<string | null> {
  if (!source.excludedRoots?.length) return realpath(path).catch(() => null);
  try {
    const absolute = resolve(path);
    let directory = parsePath(absolute).root;
    let segments = absolute.slice(directory.length).split(pathSeparator).toReversed();
    let hops = 0;
    while (segments.length) {
      const segment = segments.pop()!;
      if (!segment) continue;
      const candidate = join(directory, segment);
      if (isExcludedCursorPath(source, candidate)) return null;
      const info = await lstat(candidate, { bigint: true });
      if (info.isDirectory() && source.excludedDirectoryIds?.has(directoryId(info))) return null;
      if (!info.isSymbolicLink()) {
        directory = candidate;
        continue;
      }
      if (++hops > 40) return null;
      const link = await readlink(candidate);
      const anchor = parsePath(link).root;
      if (anchor) directory = anchor;
      segments.push(...link.slice(anchor.length).split(pathSeparator).toReversed());
    }
    const canonical = await realpath(path);
    if (!areEquivalentPaths(directory, canonical) || isExcludedCursorPath(source, canonical))
      return null;
    return canonical;
  } catch {
    // Broken links and disappearing directories do not contribute skills.
  }
  return null;
}

export async function resolveCursorSkillRoot(source: CursorSkillRoot): Promise<string | null> {
  if (!isAllowedSkillPath(source, source.path)) return null;
  return resolveCursorDiscoveryPath(source, source.path);
}

interface CursorSkillDirectory {
  path: string;
  canonical: string;
  hasSkill: boolean;
  links: string[];
}

export async function* walkCursorSkillDirectories(
  source: CursorSkillRoot,
  root: string,
): AsyncGenerator<CursorSkillDirectory> {
  const resolveChildDirectory = async (child: string) => {
    const target = await resolveCursorDiscoveryPath(source, child);
    if (!target) return null;
    return (await stat(target).catch(() => null))?.isDirectory() ? target : null;
  };
  const pending = [{ path: source.path, canonical: root, depth: 0 }];
  const visited = new Set([root]);
  let remaining = maxEntries;
  for (const { path, canonical, depth } of pending) {
    if (!remaining || (await resolveCursorDiscoveryPath(source, path)) !== canonical) continue;
    const handle = await opendir(canonical).catch(() => null);
    if (!handle) continue;
    let hasSkill = false;
    const folders: Dirent[] = [];
    try {
      for await (const entry of handle) {
        remaining -= 1;
        if (entry.name === "SKILL.md" && entry.isFile()) hasSkill = true;
        if (
          depth < maxDepth &&
          !entry.name.startsWith(".") &&
          (entry.isDirectory() || entry.isSymbolicLink())
        ) {
          folders.push(entry);
        }
        if (!remaining) break;
      }
    } catch {
      continue;
    }
    yield {
      path,
      canonical,
      hasSkill,
      links: folders.filter((entry) => entry.isSymbolicLink()).map(({ name }) => join(path, name)),
    };
    for (const { name } of folders.sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    )) {
      if (visited.size === maxDirectories || !remaining) break;
      const child = join(path, name);
      const target = await resolveChildDirectory(child);
      if (!target || visited.has(target)) continue;
      visited.add(target);
      pending.push({ path: child, canonical: target, depth: depth + 1 });
    }
  }
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function canonicalDirectoryStamp(boundary: string, directory: string): Promise<string> {
  const identities: string[] = [];
  for (let current = directory; isPathInsideRoot(boundary, current); current = dirname(current)) {
    const { dev, ino, ctimeNs } = await stat(current, { bigint: true });
    identities.push(`${dev}:${ino}:${ctimeNs}`);
    if (current === boundary) break;
  }
  return identities.join("/");
}

export async function readBoundedCursorFile(
  path: string,
  root: string,
  source: Pick<CursorSkillRoot, "boundary" | "excludedRoots">,
  maxBytes: number,
  truncate = false,
): Promise<{ bytes: Buffer; path: string } | null> {
  const candidate = await realpath(path);
  if (!isPathInsideRoot(root, candidate) || !isAllowedSkillPath(source, candidate)) return null;
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  // Linux can check the descriptor's path directly. Elsewhere verify the entire
  // canonical ancestry through the open window as well as the file identity.
  const parent = dirname(candidate);
  const ancestry =
    process.platform === "linux" ? null : await canonicalDirectoryStamp(source.boundary, parent);
  const file = await open(candidate, flags);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || (!truncate && before.size > maxBytes)) return null;
    const readSize = before.size > maxBytes ? maxBytes : Number(before.size);
    const openedPath = process.platform === "linux" ? `/proc/self/fd/${file.fd}` : candidate;
    if ((await realpath(openedPath)) !== candidate) return null;
    const matchesPath = async () => {
      const current = await stat(candidate, { bigint: true });
      return (
        before.dev === current.dev &&
        before.ino === current.ino &&
        (ancestry === null || (await canonicalDirectoryStamp(source.boundary, parent)) === ancestry)
      );
    };
    if (!(await matchesPath())) return null;
    const bytes = Buffer.alloc(readSize);
    const result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat({ bigint: true });
    if (
      readSize !== result.bytesRead ||
      before.ctimeNs !== after.ctimeNs ||
      (await realpath(path)) !== candidate ||
      !(await matchesPath())
    ) {
      return null;
    }
    return { bytes: bytes.subarray(0, result.bytesRead), path: candidate };
  } finally {
    await file.close();
  }
}

function canSelectSkill(metadata: object): boolean {
  if ("enabled" in metadata && metadata.enabled === false) return false;
  if ("disable-user-invocation" in metadata && metadata["disable-user-invocation"] === true) {
    return false;
  }
  const details = "metadata" in metadata ? metadata.metadata : undefined;
  if (!details || typeof details !== "object" || !("surfaces" in details)) return true;
  const surfaces = details.surfaces;
  const allowed =
    typeof surfaces === "string"
      ? surfaces
          .split(",")
          .map((surface) => surface.trim())
          .filter(Boolean)
      : surfaces;
  // SDK 1.4.2 identifies this surface as "sdk". Model-only invocation restrictions
  // do not disable a user's explicit selection.
  return !Array.isArray(allowed) || allowed.length === 0 || allowed.includes("sdk");
}

// Codex e0a6d05 (Apache-2.0), skills/src/parser.rs: retry plain scalar
// values containing a YAML colon separator with the value quoted.
function parseSkillFrontmatter(frontmatter: string): unknown {
  try {
    return parse(frontmatter, { maxAliasCount: 0 });
  } catch {
    let blockIndent: number | undefined;
    const repaired = frontmatter.split("\n").map((line) => {
      const indent = line.length - line.trimStart().length;
      if (blockIndent !== undefined && (!line.trim() || indent > blockIndent)) return line;
      blockIndent = undefined;
      const match = /^(\s*[^:#\n][^:\n]*:\s+)(\S.*)$/.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      if (/^[|>]/.test(value)) blockIndent = indent;
      if (/^['"|>]/.test(value)) return line;
      const comment = value.search(/\s+#/);
      const scalar = comment === -1 ? value.trimEnd() : value.slice(0, comment);
      if (!/:\s/.test(scalar)) return line;
      return key + JSON.stringify(scalar) + (comment === -1 ? "" : value.slice(comment));
    });
    return parse(repaired.join("\n"), { maxAliasCount: 0 });
  }
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseSkill(markdown: string, defaultName: string) {
  const frontmatter = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(
    markdown,
  );
  if (!frontmatter) return null;
  const metadata: unknown = parseSkillFrontmatter(frontmatter[1]);
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const configuredName = "name" in metadata ? metadata.name : undefined;
  const description = "description" in metadata ? metadata.description : undefined;
  if (configuredName != null && typeof configuredName !== "string") return null;
  const name = (configuredName && singleLine(configuredName)) || defaultName;
  if (
    !canSelectSkill(metadata) ||
    [...name].length > 64 ||
    typeof description !== "string" ||
    !description.trim()
  ) {
    return null;
  }
  return {
    name,
    description: singleLine(description).slice(0, 1536),
    instructions: markdown.slice(frontmatter[0].length),
  };
}

async function readSkill(
  source: CursorSkillRoot,
  root: string,
  directory: CursorSkillDirectory,
): Promise<ResolvedCursorSkill | null> {
  try {
    const file = join(directory.canonical, "SKILL.md");
    if (!(await lstat(file)).isFile()) return null;
    const resolved = await readBoundedCursorFile(
      file,
      directory.canonical,
      { boundary: directory.canonical, excludedRoots: source.excludedRoots },
      maxSkillBytes,
    );
    if (
      !resolved ||
      resolved.path !== file ||
      !(await lstat(file)).isFile() ||
      (await resolveCursorDiscoveryPath(source, directory.path)) !== directory.canonical ||
      (await resolveCursorSkillRoot(source)) !== root
    )
      return null;
    const { bytes, path } = resolved;
    const metadata = parseSkill(bytes.toString("utf8"), basename(directory.path));
    if (!metadata) return null;
    const { name, description, instructions } = metadata;
    const id = sha256(
      JSON.stringify([
        source.scope,
        source.boundary,
        source.path,
        root,
        relative(source.path, directory.path),
        path,
      ]),
    );
    return {
      name,
      reference: {
        id,
        revision: sha256(bytes),
        name: skillName.test(name) ? name : "skill-" + id.slice(0, 16),
        scope: source.scope,
      },
      description,
      path,
      instructions,
    };
  } catch {
    // A missing, unreadable, or invalid skill never hides the rest of the catalog.
    return null;
  }
}

async function readCursorSkills(roots: readonly CursorSkillRoot[]): Promise<ResolvedCursorSkill[]> {
  const skills: ResolvedCursorSkill[] = [];
  for (const source of roots) {
    const root = await resolveCursorSkillRoot(source);
    if (!root) continue;
    for await (const directory of walkCursorSkillDirectories(source, root)) {
      if (!directory.hasSkill) continue;
      const skill = await readSkill(source, root, directory);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

export async function scanCursorSkills(
  roots: readonly CursorSkillRoot[],
): Promise<ResolvedCursorSkill[]> {
  const byPath = new Map<string, ResolvedCursorSkill>();
  for (const skill of await readCursorSkills(roots)) {
    if (!byPath.has(skill.path)) byPath.set(skill.path, skill);
  }
  return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export async function resolveCursorSkills(
  roots: readonly CursorSkillRoot[],
  references: readonly CursorSkillReference[],
): Promise<ResolvedCursorSkill[]> {
  if (references.length === 0) return [];
  const available = new Map(
    (await readCursorSkills(roots)).map((skill) => [skill.reference.id, skill]),
  );
  const selected = new Set<string>();
  let selectedBytes = 0;
  return references.map((reference) => {
    const skill = available.get(reference.id);
    if (
      !skill ||
      skill.reference.name !== reference.name ||
      skill.reference.revision !== reference.revision ||
      skill.reference.scope !== reference.scope
    ) {
      throw new Error(
        `Cursor skill "${reference.name}" changed or is unavailable. Remove it and select it again from the skill menu.`,
      );
    }
    if (selected.has(reference.id)) {
      throw new Error(`Select Cursor skill "${reference.name}" only once per message.`);
    }
    selected.add(reference.id);
    selectedBytes += Buffer.byteLength(skill.instructions);
    if (selectedBytes > maxSelectedBytes) {
      throw new Error("Select fewer Cursor skills. Their combined instructions are too large.");
    }
    return skill;
  });
}

export function renderSelectedCursorSkills(
  text: string,
  skills: readonly ResolvedCursorSkill[] | undefined,
): string {
  if (!skills?.length) return text;
  const selected = skills.map(({ name, reference, path, instructions }) => ({
    name,
    scope: reference.scope,
    path,
    instructions,
  }));
  return [
    "<paseo_selected_cursor_skills>",
    "The user explicitly selected these skills. Apply their instructions to the request below.",
    JSON.stringify(selected),
    "</paseo_selected_cursor_skills>",
    "",
    text,
  ].join("\n");
}
