import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { connectToDaemon } from "../../utils/client.js";
import { runFileCommand } from "./run.js";
import { createFileCommand } from "./index.js";

const options = {
  cwd: "/remote",
  daemonTarget: { kind: "endpoint", endpoint: "ws://host" },
} as Parameters<typeof runFileCommand>[2];
function fixture(extra = {}) {
  const client = { close: vi.fn().mockResolvedValue(undefined), ...extra };
  return {
    client,
    connect: vi.fn().mockResolvedValue(client) as unknown as typeof connectToDaemon,
  };
}
describe("host files", () => {
  it("exposes direct destructive operations without confirmation flags", () => {
    const command = createFileCommand();
    for (const name of ["rm", "write"]) {
      const child = command.commands.find((c) => c.name() === name)!;
      expect(child.options.some((o) => ["--force", "--yes"].includes(o.long!))).toBe(false);
    }
    expect(command.commands.map((c) => c.name())).toContain("download");
  });
  it("uses host cwd, reports unsuccessful mutations and closes", async () => {
    const f = fixture({
      deleteFileEntry: vi.fn().mockResolvedValue({ success: false, error: "denied" }),
    });
    await expect(runFileCommand("rm", ["a"], options, f.connect)).rejects.toMatchObject({
      code: "FILE_OPERATION_FAILED",
    });
    expect(f.client.deleteFileEntry).toHaveBeenCalledWith({ cwd: "/remote", path: "a" });
    expect(f.client.close).toHaveBeenCalledOnce();
  });
  it("resolves workspace IDs on the selected daemon", async () => {
    const f = fixture({
      fetchWorkspaces: vi
        .fn()
        .mockResolvedValue({ entries: [{ id: "w", workspaceDirectory: "/remote/workspace" }] }),
      listDirectory: vi.fn().mockResolvedValue({ entries: [] }),
    });
    await runFileCommand("ls", [], { ...options, cwd: undefined, workspace: "w" }, f.connect);
    expect(f.client.listDirectory).toHaveBeenCalledWith("/remote/workspace", "");
    expect(f.connect).toHaveBeenCalledWith({ target: options.daemonTarget });
  });
  it("rejects remote operations without an explicit root", async () => {
    const f = fixture();
    await expect(
      runFileCommand("ls", [], { ...options, cwd: undefined }, f.connect),
    ).rejects.toMatchObject({ code: "MISSING_TARGET" });
  });
  it("preserves bytes, detects write conflicts and never overwrites local downloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-file-unit-"));
    try {
      const bytes = Buffer.from([0, 1, 2]);
      const input = join(dir, "input");
      await writeFile(input, bytes);
      const f = fixture({
        getLastServerInfoMessage: () => ({ features: { fileByteWrites: true } }),
        readFile: vi.fn().mockResolvedValue({
          bytes,
          modifiedAt: "m",
          revision: "r",
          size: 4,
          path: "a",
          kind: "binary",
          mime: "application/octet-stream",
        }),
        writeFile: vi.fn().mockResolvedValue({ status: "conflict", version: {} }),
      });
      const cat = await runFileCommand("cat", ["a"], options, f.connect);
      expect(cat.data.content).toBe(bytes.toString("base64"));
      expect(() => cat.schema.renderHuman!(cat, {} as never)).toThrow();
      await expect(
        runFileCommand("write", ["a"], { ...options, input }, f.connect),
      ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
      expect(f.client.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          content: bytes.toString("base64"),
          contentEncoding: "base64",
          expectedModifiedAt: "m",
          expectedRevision: "r",
        }),
      );
      const output = join(dir, "output");
      await runFileCommand("download", ["a", output], options, f.connect);
      expect(await readFile(output)).toEqual(bytes);
      await expect(
        runFileCommand("download", ["a", output], options, f.connect),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
