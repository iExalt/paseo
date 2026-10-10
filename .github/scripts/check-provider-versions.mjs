import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = fileURLToPath(new URL("../deep-providers/", import.meta.url));
const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
const home = mkdtempSync(join(tmpdir(), "paseo-provider-versions-"));
try {
  for (const [name, binary, expected] of [
    ["@anthropic-ai/claude-code", "claude", "2.1.296 (Claude Code)"],
    ["@openai/codex", "codex", "codex-cli 0.162.1"],
    ["opencode-ai", "opencode", "1.18.35"],
  ]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry.integrity && entry.resolved, `Missing locked integrity for ${name}`);
    const installed = JSON.parse(
      readFileSync(join(prefix, "node_modules", name, "package.json"), "utf8"),
    );
    assert.equal(installed.version, entry.version);
    const version = execFileSync(join(prefix, "node_modules/.bin", binary), ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        CI: "true",
        CI_DEEP_OWNER: process.env.CI_DEEP_OWNER,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        DISABLE_AUTOUPDATER: "1",
      },
    }).trim();
    assert.equal(version, expected);
    console.log(`${name}: ${version}; ${entry.integrity}`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
