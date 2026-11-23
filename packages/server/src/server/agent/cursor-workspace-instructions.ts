import { constants as bufferConstants } from "node:buffer";
import { opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { cursorProjectDirectories } from "./cursor-project-directories.js";
import {
  isAllowedSkillPath,
  readBoundedCursorFile,
  type CursorSkillRoot,
} from "./cursor-skill-catalog.js";

// Codex e0a6d05, config/src/config_toml.rs: the default budget excludes global instructions.
const projectDocMaxBytes = 32 * 1024;
const filenames = ["AGENTS.override.md", "AGENTS.md"];

async function readGlobalInstructions(
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<string | undefined> {
  for (const name of filenames) {
    const path = join(resolve(codexHome), name);
    const canonical = await realpath(path).catch(() => null);
    if (!canonical) continue;
    const directory = dirname(canonical);
    const file = await readBoundedCursorFile(
      path,
      directory,
      { boundary: directory },
      bufferConstants.MAX_STRING_LENGTH,
    ).catch(() => null);
    const text = file?.bytes.toString("utf8").trim();
    if (text) return text;
  }
}

// SDK settingSources deliberately stays empty. Only instruction text is loaded.
export async function readCursorWorkspaceInstructions(
  cwd: string,
  sources: readonly CursorSkillRoot[],
  codexHome?: string,
): Promise<string | undefined> {
  const global = await readGlobalInstructions(codexHome);
  const source = sources.find(({ scope }) => scope === "workspace");
  const instructions = global ? ["Global instructions:\n" + global] : [];
  if (source) {
    const directory = await realpath(cwd).catch(() => null);
    if (directory && isAllowedSkillPath(source, directory)) {
      instructions.push(...(await readProjectInstructions(directory, source)));
    }
  }
  return instructions.length ? instructions.join("\n\n") : undefined;
}

type InstructionRoot = Pick<CursorSkillRoot, "boundary" | "excludedRoots">;

async function readProjectInstructions(cwd: string, workspace: InstructionRoot): Promise<string[]> {
  const directories = await cursorProjectDirectories(cwd);
  const project = { boundary: directories[0], excludedRoots: workspace.excludedRoots };
  if (!isAllowedSkillPath(project, cwd)) return [];
  const instructions: string[] = [];
  let remaining = projectDocMaxBytes;
  const read = async (root: InstructionRoot, path: string, cursorRule = false) => {
    const file = await readBoundedCursorFile(
      path,
      dirname(path),
      root,
      cursorRule ? projectDocMaxBytes : remaining,
      true,
    ).catch(() => null);
    if (!file || file.path !== path) return false;
    const text = file.bytes.toString("utf8");
    const body = cursorRule ? alwaysApplyBody(text) : text;
    if (body?.trim()) {
      instructions.push(
        "Workspace instructions from " +
          relative(root.boundary, path) +
          ":\n" +
          Buffer.from(body).subarray(0, remaining).toString("utf8").trim(),
      );
      remaining -= Math.min(remaining, file.bytes.length);
    }
    return true;
  };
  for (const directory of directories) {
    if (!remaining) return instructions;
    if (!isAllowedSkillPath(project, directory)) continue;
    for (const name of filenames) {
      if (await read(project, join(directory, name))) break;
    }
  }
  if (remaining) await read(workspace, join(workspace.boundary, ".cursorrules"));
  if (remaining) {
    for (const path of await cursorRulePaths(workspace)) {
      if (!remaining) break;
      await read(workspace, path, true);
    }
  }
  return instructions;
}

async function cursorRulePaths(source: InstructionRoot): Promise<string[]> {
  const rules = join(source.boundary, ".cursor", "rules");
  if (!isAllowedSkillPath(source, rules) || (await realpath(rules).catch(() => null)) !== rules)
    return [];
  const dir = await opendir(rules).catch(() => null);
  if (!dir) return [];
  const names: string[] = [];
  for await (const entry of dir) {
    if (entry.isFile() && entry.name.endsWith(".mdc")) names.push(entry.name);
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
