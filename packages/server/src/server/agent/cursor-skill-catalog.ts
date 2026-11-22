import type { CursorSkillReference } from "@getpaseo/protocol/messages";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { areEquivalentPaths, isPathInsideRoot } from "../../utils/path.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

const maxSkillBytes = 64 * 1024;
const maxSelectedBytes = 128 * 1024;
const skillName = /^[a-z][a-z0-9-]{0,63}$/;

export interface CursorSkillRoot {
  path: string;
  boundary: string;
  scope: "workspace" | "user";
  excludedRoots?: readonly string[];
}

export interface ResolvedCursorSkill {
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

export async function cursorSkillRoots(
  target: CursorSkillTarget,
  workspaceRegistry?: {
    listActive(): Promise<
      readonly Pick<PersistedWorkspaceRecord, "cwd" | "workspaceId" | "untrustedSource">[]
    >;
  },
  userHome = homedir(),
): Promise<CursorSkillRoot[]> {
  const [cwd, home, workspaces] = await Promise.all([
    realpath(target.cwd).catch(() => null),
    realpath(userHome).catch(() => null),
    workspaceRegistry?.listActive() ?? [],
  ]);
  const canonical = await Promise.all(
    workspaces.map(async (workspace) => ({
      workspace,
      boundary: await realpath(workspace.cwd).catch(() => null),
    })),
  );
  const excludedRoots = canonical.flatMap(({ workspace, boundary }) =>
    workspace.untrustedSource && boundary ? [boundary] : [],
  );
  const matching = cwd
    ? canonical
        .filter(
          ({ workspace, boundary }) =>
            boundary &&
            areEquivalentPaths(workspace.cwd, boundary) &&
            isPathInsideRoot(boundary, cwd) &&
            (!target.workspaceId || workspace.workspaceId === target.workspaceId),
        )
        .sort((left, right) => right.boundary!.length - left.boundary!.length)
    : [];
  const workspace = matching[0];
  const sources: CursorSkillRoot[] = [];
  const addScope = (scope: CursorSkillRoot["scope"], boundary: string) => {
    for (const directory of [".cursor", ".agents"]) {
      const path = join(boundary, directory, "skills");
      sources.push({ path, boundary, scope, excludedRoots });
    }
  };
  if (
    target.skillScope !== "user" &&
    workspace?.boundary &&
    cwd &&
    !excludedRoots.some((root) => isPathInsideRoot(root, cwd))
  ) {
    addScope("workspace", workspace.boundary);
  }
  if (home) addScope("user", home);
  return sources;
}

export async function resolveCursorSkillRoot(source: CursorSkillRoot): Promise<string | null> {
  const [root, parent] = await Promise.all(
    [source.path, dirname(source.path)].map((path) => realpath(path).catch(() => null)),
  );
  return root &&
    parent &&
    root !== source.boundary &&
    isAllowedSkillPath(source, root) &&
    isAllowedSkillPath(source, parent)
    ? root
    : null;
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
    if (!before.isFile() || before.size > maxBytes) return null;
    const openedPath = process.platform === "linux" ? `/proc/self/fd/${file.fd}` : candidate;
    if ((await realpath(openedPath)) !== candidate) return null;
    const verified = await stat(candidate, { bigint: true });
    if (
      verified.dev !== before.dev ||
      verified.ino !== before.ino ||
      (ancestry !== null && (await canonicalDirectoryStamp(source.boundary, parent)) !== ancestry)
    )
      return null;
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat({ bigint: true });
    const current = await stat(candidate, { bigint: true });
    if (
      before.size !== BigInt(result.bytesRead) ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      (await realpath(path)) !== candidate ||
      (ancestry !== null && (await canonicalDirectoryStamp(source.boundary, parent)) !== ancestry)
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

async function readSkill(
  source: CursorSkillRoot,
  root: string,
  directory: string,
): Promise<ResolvedCursorSkill | null> {
  try {
    const resolved = await readBoundedCursorFile(
      join(root, directory, "SKILL.md"),
      root,
      source,
      maxSkillBytes,
    );
    if (!resolved || (await realpath(source.path)) !== root) return null;
    const { bytes, path } = resolved;
    const markdown = bytes.toString("utf8");
    const frontmatter = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(
      markdown,
    );
    if (!frontmatter) return null;
    const metadata: unknown = parse(frontmatter[1], { maxAliasCount: 0 });
    if (typeof metadata !== "object" || metadata === null) return null;
    const name = "name" in metadata ? metadata.name : undefined;
    const description = "description" in metadata ? metadata.description : undefined;
    if (
      !canSelectSkill(metadata) ||
      typeof name !== "string" ||
      !skillName.test(name) ||
      typeof description !== "string" ||
      !description.trim()
    ) {
      return null;
    }
    return {
      reference: {
        id: sha256(
          JSON.stringify([source.scope, source.boundary, source.path, root, directory, path]),
        ),
        revision: sha256(bytes),
        name,
        scope: source.scope,
      },
      description: description.trim().slice(0, 1536),
      path,
      instructions: markdown.slice(frontmatter[0].length),
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
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const skill = await readSkill(source, root, entry.name);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

export async function scanCursorSkills(
  roots: readonly CursorSkillRoot[],
): Promise<ResolvedCursorSkill[]> {
  const byName = new Map<string, ResolvedCursorSkill>();
  for (const skill of await readCursorSkills(roots)) {
    if (!byName.has(skill.reference.name)) byName.set(skill.reference.name, skill);
  }
  return [...byName.values()].sort((left, right) =>
    left.reference.name.localeCompare(right.reference.name, "en"),
  );
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
  const selected = skills.map(({ reference, path, instructions }) => ({
    name: reference.name,
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
