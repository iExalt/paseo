import { opendir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";
import { isPathInsideRoot } from "../../utils/path.js";
import {
  isAllowedSkillPath,
  readBoundedCursorFile,
  type CursorSkillRoot,
} from "./cursor-skill-catalog.js";

const maxFiles = 32;
const maxBytes = 64 * 1024;

// SDK settingSources deliberately stays empty. The project layer also enables
// executable configuration, so only trusted instruction text goes in the prompt.
export async function readCursorWorkspaceInstructions(
  cwd: string,
  sources: readonly CursorSkillRoot[],
): Promise<string | undefined> {
  const source = sources.find(({ scope }) => scope === "workspace");
  if (!source) return undefined;
  const directory = await realpath(cwd).catch(() => null);
  if (!directory || !isAllowedSkillPath(source, directory)) return undefined;
  const { boundary } = source;
  const paths: string[] = [];
  for (let dir = directory; isPathInsideRoot(boundary, dir); dir = dirname(dir)) {
    paths.unshift(join(dir, "AGENTS.md"));
    if (dir === boundary) break;
  }
  paths.push(join(boundary, ".cursorrules"));

  paths.push(...(await cursorRulePaths(source)));

  const instructions: string[] = [];
  let bytesLeft = maxBytes;
  for (const path of paths.slice(0, maxFiles)) {
    const file = await readBoundedCursorFile(path, dirname(path), source, bytesLeft).catch(
      () => null,
    );
    if (!file || file.path !== path) continue;
    const text = file.bytes.toString("utf8");
    const body = path.endsWith(".mdc") ? alwaysApplyBody(text) : text;
    if (!body?.trim()) continue;
    bytesLeft -= file.bytes.length;
    instructions.push(`Workspace instructions from ${relative(boundary, path)}:\n${body.trim()}`);
  }
  return instructions.length ? instructions.join("\n\n") : undefined;
}

async function cursorRulePaths(source: CursorSkillRoot): Promise<string[]> {
  const rules = join(source.boundary, ".cursor", "rules");
  if (!isAllowedSkillPath(source, rules) || (await realpath(rules).catch(() => null)) !== rules)
    return [];
  const dir = await opendir(rules).catch(() => null);
  if (!dir) return [];
  const names: string[] = [];
  for await (const entry of dir) {
    if (entry.isFile() && entry.name.endsWith(".mdc")) names.push(entry.name);
    // Skip an oversized rule directory rather than inject an arbitrary subset.
    if (names.length > maxFiles) return [];
  }
  return names.sort().map((name) => join(rules, name));
}

function alwaysApplyBody(text: string): string | undefined {
  const match = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  try {
    const metadata: unknown = parse(match[1], { maxAliasCount: 0 });
    if (
      metadata &&
      typeof metadata === "object" &&
      "alwaysApply" in metadata &&
      metadata.alwaysApply === true
    ) {
      return text.slice(match[0].length);
    }
  } catch {
    // Ignore malformed rule frontmatter.
  }
}
