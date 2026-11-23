import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cursorSkillRoots } from "./cursor-skill-catalog.js";
import { readCursorWorkspaceInstructions } from "./cursor-workspace-instructions.js";

it("reads only authorized workspace instruction text for the current directory", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "paseo-cursor-instructions-")));
  try {
    const workspace = join(scratch, "workspace");
    const child = join(workspace, "child");
    const codexHome = join(scratch, "codex");
    const outside = join(scratch, "outside.md");
    const rules = join(workspace, ".cursor", "rules");
    await Promise.all([mkdir(child, { recursive: true }), mkdir(rules, { recursive: true })]);
    await Promise.all([
      mkdir(join(workspace, ".git")),
      writeFile(join(workspace, "AGENTS.md"), "root instruction"),
      writeFile(join(child, "AGENTS.md"), "child instruction"),
      writeFile(join(rules, "always.mdc"), "---\nalwaysApply: true\n---\nalways instruction"),
      writeFile(join(rules, "context.mdc"), "---\nglobs: '*.ts'\n---\ncontext instruction"),
      writeFile(outside, "external text"),
    ]);
    await symlink(outside, join(workspace, ".cursorrules"), "file");
    const trusted = { workspaceId: "all", cwd: workspace };
    const untrusted = {
      workspaceId: "fork",
      cwd: child,
      untrustedSource: {
        kind: "change_request",
        forge: "github",
        number: 1,
        headRepository: "fixture/repo",
      },
    } as const;
    const read = async (workspaceId: string, blocked = false) =>
      readCursorWorkspaceInstructions(
        child,
        await cursorSkillRoots(
          { cwd: child, workspaceId },
          { listActive: async () => (blocked ? [trusted, untrusted] : [trusted]) },
          scratch,
        ),
        codexHome,
      );

    const instructions = await read(trusted.workspaceId);
    expect(instructions).toContain("root instruction");
    expect(instructions).toContain("child instruction");
    expect(instructions).toContain("always instruction");
    expect(instructions).not.toContain("context instruction");
    expect(instructions).not.toContain("external text");
    expect(await read("another-workspace")).toBeUndefined();
    expect(await read(trusted.workspaceId, true)).toBeUndefined();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it("prefers global overrides, follows Nix links, and loads global instructions without a workspace", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "paseo-cursor-global-")));
  try {
    const home = join(scratch, "codex");
    const store = join(scratch, "nix-store");
    await Promise.all([mkdir(home), mkdir(store)]);
    const target = join(store, "AGENTS.md");
    await writeFile(target, "global fallback");
    await symlink(target, join(home, "AGENTS.md"), "file");
    const override = join(home, "AGENTS.override.md");
    await writeFile(override, "  \n");
    const read = () => readCursorWorkspaceInstructions(scratch, [], home);
    expect(await read()).toBe("Global instructions:\nglobal fallback");
    await writeFile(override, "global override");
    expect(await read()).toBe("Global instructions:\nglobal override");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it("orders project override files root to cwd and truncates the crossing file at 32 KiB", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "paseo-cursor-budget-")));
  try {
    const project = join(scratch, "project");
    const child = join(project, "child");
    const cwd = join(child, "leaf");
    const home = join(scratch, "codex");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home)]);
    const rules = join(child, ".cursor", "rules");
    await mkdir(rules, { recursive: true });
    const rootText = "A".repeat(32 * 1024 - 4);
    await Promise.all([
      writeFile(join(project, ".git"), "gitdir: /unused"),
      writeFile(join(scratch, "AGENTS.md"), "above root"),
      writeFile(join(home, "AGENTS.md"), "global"),
      writeFile(join(project, "AGENTS.md"), "shadowed"),
      writeFile(join(project, "AGENTS.override.md"), rootText),
      writeFile(join(child, "AGENTS.md"), "BCDE beyond budget"),
      writeFile(join(cwd, "AGENTS.md"), "leaf beyond budget"),
      writeFile(join(child, ".cursorrules"), "registered workspace cursor rules"),
      writeFile(join(rules, "always.mdc"), "---\nalwaysApply: true\n---\nregistered always rule"),
    ]);
    const read = () =>
      readCursorWorkspaceInstructions(
        cwd,
        [{ scope: "workspace", boundary: child, path: join(child, ".agents", "skills") }],
        home,
      );
    expect(await read()).toBe(
      "Global instructions:\nglobal\n\n" +
        "Workspace instructions from AGENTS.override.md:\n" +
        rootText +
        "\n\n" +
        "Workspace instructions from " +
        join("child", "AGENTS.md") +
        ":\nBCDE",
    );
    await writeFile(join(project, "AGENTS.override.md"), "");
    const withEmptyOverride = await read();
    expect(withEmptyOverride).toContain("leaf beyond budget");
    expect(withEmptyOverride).toContain("registered workspace cursor rules");
    expect(withEmptyOverride).toContain("registered always rule");
    expect(await read()).not.toMatch(/above root|shadowed/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
