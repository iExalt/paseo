import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cursorSkillRoots,
  resolveCursorSkills,
  scanCursorSkills,
  type CursorSkillRoot,
} from "./cursor-skill-catalog.js";

let scratch: string;
let workspace: string;
let home: string;

beforeEach(async () => {
  vi.stubEnv("CODEX_HOME", undefined);
  scratch = await realpath(await mkdtemp(join(tmpdir(), "cursor-skill-catalog-")));
  workspace = join(scratch, "workspace");
  home = join(scratch, "home");
  await mkdir(workspace);
  await mkdir(home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

async function writeSkill(root: string, name: string, mark: string, fields = "") {
  const filename = join(root, name, "SKILL.md");
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(
    filename,
    `---\nname: ${name}\ndescription: >\n  Run the ${mark}\n  canary.\n${fields}---\n${mark}\n`,
  );
}

it("uses workspace precedence and publishes stable identities whose revisions change with the bytes", async () => {
  const root = join(workspace, "linked-skills");
  const path = join(workspace, "skills");
  const userPath = join(home, "skills");
  await writeSkill(root, "my-skill", "workspace");
  await writeSkill(userPath, "my-skill", "user");
  await symlink(root, path, "junction");

  const roots = [
    { path, boundary: workspace, scope: "workspace" },
    { path: userPath, boundary: home, scope: "user" },
  ] satisfies CursorSkillRoot[];

  const [first, sameName] = await scanCursorSkills(roots);
  expect(first).toMatchObject({
    reference: { name: "my-skill", scope: "workspace" },
    description: "Run the workspace canary.",
    instructions: "workspace\n",
  });
  expect(sameName.reference).toMatchObject({ name: "my-skill", scope: "user" });
  expect(sameName.reference.id).not.toBe(first.reference.id);
  expect(await scanCursorSkills(roots)).toEqual([first, sameName]);
  const [explicitUser] = await scanCursorSkills([roots[1]]);
  await expect(resolveCursorSkills(roots, [explicitUser.reference])).resolves.toEqual([
    explicitUser,
  ]);

  await writeSkill(root, "my-skill", "edited");
  const [edited] = await scanCursorSkills(roots);
  expect(edited.reference.id).toBe(first.reference.id);
  expect(edited.reference.revision).not.toBe(first.reference.revision);
  await expect(resolveCursorSkills(roots, [first.reference])).rejects.toThrow("select it again");
  await expect(resolveCursorSkills(roots, [edited.reference])).resolves.toEqual([edited]);
  await expect(resolveCursorSkills(roots, [edited.reference, edited.reference])).rejects.toThrow(
    "only once",
  );

  await writeSkill(root, "my-skill", "disabled", "enabled: false\n");
  const [user] = await scanCursorSkills(roots);
  expect(user.reference.scope).toBe("user");
  expect(user.reference.id).not.toBe(first.reference.id);
  await expect(resolveCursorSkills(roots, [edited.reference])).rejects.toThrow("select it again");
});

it("follows directory links outside home, deduplicates aliases, and refuses SKILL.md links", async () => {
  const store = join(scratch, "nix", "store");
  await writeSkill(store, "linked", "store");
  const root = join(home, ".codex", "skills");
  await mkdir(root, { recursive: true });
  const linkedRoot = join(home, ".agents", "skills");
  await mkdir(dirname(linkedRoot));
  await symlink(store, linkedRoot, "junction");
  await symlink(join(store, "linked"), join(root, "external"), "junction");
  await symlink(root, join(store, "linked", "loop"), "junction");
  await mkdir(join(root, "file-link"));
  await symlink(join(store, "linked", "SKILL.md"), join(root, "file-link", "SKILL.md"), "file");
  await writeSkill(root, ".hidden", "ignored");
  const roots = await cursorSkillRoots({ cwd: workspace, skillScope: "user" }, undefined, home);
  const entries = await scanCursorSkills(roots);
  expect(entries.map(({ name, path }) => [name, path])).toEqual([
    ["linked", join(store, "linked", "SKILL.md")],
  ]);

  // A user-only new-worktree draft can send the same reference after deduplication
  // chooses the workspace alias for normal menus.
  const alias = join(workspace, ".agents", "skills");
  await mkdir(dirname(alias));
  await symlink(store, alias, "junction");
  const full = await cursorSkillRoots({ cwd: workspace }, undefined, home);
  expect((await scanCursorSkills(full)).map(({ reference }) => reference.scope)).toEqual([
    "workspace",
  ]);
  await expect(resolveCursorSkills(full, [entries[0].reference])).resolves.toEqual(entries);
});

it("allows a skills root link to the project boundary", async () => {
  await writeSkill(join(workspace, "extras"), "linked", "project skill");
  await mkdir(join(workspace, ".agents"));
  await symlink(workspace, join(workspace, ".agents", "skills"), "junction");
  const roots = await cursorSkillRoots({ cwd: workspace }, undefined, home);
  expect((await scanCursorSkills(roots)).map(({ name }) => name)).toEqual(["linked"]);
});

it.each(["file", "directory"])("walks from a .git %s through cwd", async (kind) => {
  const cwd = join(workspace, "inner", "deep");
  const git = join(workspace, ".git");
  if (kind === "file") await writeFile(git, "gitdir: repo.git/worktrees/example\n");
  else await mkdir(git);
  await mkdir(cwd, { recursive: true });
  await writeSkill(join(scratch, ".agents", "skills"), "above", "ignored");
  await writeSkill(join(workspace, ".agents", "skills", "category"), "repo", "root");
  await writeSkill(join(workspace, "inner", ".codex", "skills"), "inner", "middle");
  await writeSkill(join(cwd, ".cursor", "skills"), "deep", "leaf");
  const roots = await cursorSkillRoots({ cwd }, undefined, home);
  expect((await scanCursorSkills(roots)).map(({ name }) => name)).toEqual([
    "deep",
    "inner",
    "repo",
  ]);
  await rm(git, { recursive: true });
  expect(
    (await scanCursorSkills(await cursorSkillRoots({ cwd }, undefined, home))).map(
      ({ name }) => name,
    ),
  ).toEqual(["deep"]);
});

it("uses Codex-valid display names, directory fallback and colon scalar repair", async () => {
  const path = join(home, ".codex", "skills");
  await mkdir(join(path, "fallback"), { recursive: true });
  await writeFile(
    join(path, "fallback", "SKILL.md"),
    "---\ndescription: Use it: good # comment\n---\nhelp\n",
  );
  await writeSkill(path, "Review_SDK", "punctuation");
  await writeSkill(path, "x".repeat(65), "too-long");
  const roots = await cursorSkillRoots({ cwd: workspace }, undefined, home);
  const items = await scanCursorSkills(roots);
  expect(items.map(({ name }) => name)).toEqual(["fallback", "Review_SDK"]);
  expect(items[0].description).toBe("Use it: good");
  expect(items[1].reference.name).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  await expect(resolveCursorSkills(roots, [items[1].reference])).resolves.toEqual([items[1]]);
});

it("honors the SDK surface and preserves manually invocable skills", async () => {
  const path = join(workspace, "skills");
  const source = { path, boundary: workspace, scope: "workspace" } satisfies CursorSkillRoot;
  await writeSkill(path, "ide-only", "ide", "metadata:\n  surfaces: [ide]\n");
  await writeSkill(path, "blocked", "blocked", "disable-user-invocation: true\n");
  await writeSkill(
    path,
    "explicit",
    "manual",
    "disable-model-invocation: true\nmetadata:\n  surfaces: ide, sdk\n",
  );
  expect((await scanCursorSkills([source])).map((skill) => skill.reference.name)).toEqual([
    "explicit",
  ]);
});

it("does not let workspace registration authorize a retargeted root or an untrusted checkout", async () => {
  const outsider = join(scratch, "outside");
  await writeSkill(outsider, "other", "outside");
  const repo = { cwd: workspace, workspaceId: "trusted" };
  const untrusted = {
    cwd: outsider,
    workspaceId: "fork",
    untrustedSource: {
      kind: "change_request",
      forge: "github",
      number: 1,
      headRepository: "example/fork",
    },
  } as const;
  const registry = { listActive: async () => [repo, untrusted] };

  const scopeFor = async (cwd: string, workspaceId?: string) =>
    (await cursorSkillRoots({ cwd, workspaceId }, registry, home)).map((root) => root.scope);
  expect(await scopeFor(workspace)).toEqual([
    "workspace",
    "workspace",
    "workspace",
    "user",
    "user",
    "user",
  ]);
  expect(await scopeFor(outsider, "fork")).toEqual(["user", "user", "user"]);
  await rm(workspace, { recursive: true });
  await symlink(outsider, workspace, "junction");
  expect(await scopeFor(workspace, "trusted")).toEqual(["user", "user", "user"]);
  const withoutUntrustedRecord = { listActive: async () => [repo] };
  expect(
    (
      await cursorSkillRoots(
        { cwd: workspace, workspaceId: "trusted" },
        withoutUntrustedRecord,
        home,
      )
    ).map((root) => root.scope),
  ).toEqual(["user", "user", "user"]);
});

it("excludes project ancestors and linked directories from untrusted workspaces", async () => {
  const untrusted = join(workspace, "fork");
  const cwd = join(untrusted, "sub");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(workspace, ".git"));
  await writeSkill(join(workspace, ".agents", "skills"), "ancestor", "root");
  await writeSkill(join(untrusted, ".agents", "skills"), "untrusted", "fork");
  const userRoot = join(home, ".codex", "skills");
  await writeSkill(userRoot, "user", "home");
  await symlink(join(untrusted, ".agents", "skills"), join(userRoot, "linked-fork"), "junction");
  const safeTarget = join(scratch, "safe-target");
  await writeSkill(safeTarget, "through-untrusted", "must be ignored");
  const hop = join(untrusted, "hop");
  await symlink(safeTarget, hop, "junction");
  await symlink(hop, join(userRoot, "through-hop"), "junction");
  const alternateCase = join(workspace, "FORK", "hop");
  if (await realpath(alternateCase).catch(() => null)) {
    await symlink(alternateCase, join(userRoot, "through-case-alias"), "junction");
  }
  const linkedRoot = join(home, ".agents", "skills");
  await mkdir(dirname(linkedRoot));
  await symlink(hop, linkedRoot, "junction");
  const registry = {
    listActive: async () => [
      { cwd, workspaceId: "trusted" },
      {
        cwd: untrusted,
        workspaceId: "untrusted",
        untrustedSource: {
          kind: "change_request",
          forge: "github",
          number: 1,
          headRepository: "example/fork",
        },
      },
    ],
  } as const;
  const roots = await cursorSkillRoots({ cwd, workspaceId: "trusted" }, registry, home);
  expect((await scanCursorSkills(roots)).map(({ name }) => name)).toEqual(["user"]);
});
