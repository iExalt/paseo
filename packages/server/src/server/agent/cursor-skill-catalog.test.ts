import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
  scratch = await realpath(await mkdtemp(join(tmpdir(), "cursor-skill-catalog-")));
  workspace = join(scratch, "workspace");
  home = join(scratch, "home");
  await mkdir(workspace);
  await mkdir(home);
});

afterEach(async () => {
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

  const [first] = await scanCursorSkills(roots);
  expect(first).toMatchObject({
    reference: { name: "my-skill", scope: "workspace" },
    description: "Run the workspace canary.",
    instructions: "workspace\n",
  });
  expect(await scanCursorSkills(roots)).toEqual([first]);
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

it("excludes escaped root, directory, and file links", async () => {
  const outside = join(scratch, "outside");
  await writeSkill(outside, "escaped", "outside");
  const path = join(workspace, "skills");
  await symlink(outside, path, "junction");
  const source = { path, boundary: workspace, scope: "workspace" } satisfies CursorSkillRoot;
  expect(await scanCursorSkills([source])).toEqual([]);

  await rm(path);
  await writeSkill(path, "approved", "inside");
  await symlink(join(outside, "escaped"), join(path, "dir-link"), "junction");
  await mkdir(join(path, "file-link"));
  await symlink(join(outside, "escaped", "SKILL.md"), join(path, "file-link", "SKILL.md"), "file");
  expect((await scanCursorSkills([source])).map((skill) => skill.reference.name)).toEqual([
    "approved",
  ]);
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
  expect(await scopeFor(workspace)).toEqual(["workspace", "workspace", "user", "user"]);
  expect(await scopeFor(outsider, "fork")).toEqual(["user", "user"]);
  await rm(workspace, { recursive: true });
  await symlink(outsider, workspace, "junction");
  expect(await scopeFor(workspace, "trusted")).toEqual(["user", "user"]);
  const withoutUntrustedRecord = { listActive: async () => [repo] };
  expect(
    (
      await cursorSkillRoots(
        { cwd: workspace, workspaceId: "trusted" },
        withoutUntrustedRecord,
        home,
      )
    ).map((root) => root.scope),
  ).toEqual(["user", "user"]);
});
