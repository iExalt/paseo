import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { codexUserMessageSkillCalls, createLiveCodexSkillTextSource } from "./skill-tool-call.js";

describe("Codex Skill cards", () => {
  // A FIFO with no writer blocks a read the way a hung network filesystem does.
  test.skipIf(process.platform === "win32")(
    "fails a live card whose SKILL.md read hangs instead of stalling the session",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "codex-skill-hang-"));
      const fifo = path.join(root, "SKILL.md");
      execFileSync("mkfifo", [fifo]);
      try {
        const calls = await codexUserMessageSkillCalls({
          messageId: "user-1",
          content: [{ type: "skill", name: "hang", path: fifo }],
          source: createLiveCodexSkillTextSource(50),
        });
        expect(calls).toEqual([
          expect.objectContaining({
            status: "failed",
            error: { message: expect.stringContaining("Paseo stopped waiting for") },
          }),
        ]);
      } finally {
        // Give the pending open a writer so the libuv thread it holds is released.
        writeFileSync(fifo, "");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
