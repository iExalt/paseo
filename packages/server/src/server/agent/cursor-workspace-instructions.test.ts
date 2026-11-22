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
    const outside = join(scratch, "outside.md");
    const rules = join(workspace, ".cursor", "rules");
    await Promise.all([mkdir(child, { recursive: true }), mkdir(rules, { recursive: true })]);
    await Promise.all([
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
