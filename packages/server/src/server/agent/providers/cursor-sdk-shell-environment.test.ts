import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import {
  prepareCursorShellEnvironment,
  canRequestCursorShellEnvironment,
  withCursorShellEnvironment,
} from "./cursor-sdk-shell-environment.js";

test("rejects unsafe names and settings overwritten by Cursor or the shell", async () => {
  for (const name of [
    "INVALID-NAME",
    "CURSOR_API_KEY",
    "__CURSOR_SANDBOX_TEMP_RESTORE",
    "PWD",
    "BASH_VERSINFO",
    "LINENO",
  ]) {
    await expect(prepareCursorShellEnvironment({ [name]: "fixture" })).rejects.toThrow(
      "cannot apply shell environment variable",
    );
  }
  await expect(prepareCursorShellEnvironment({ CUSTOM: "contains\0nul" })).rejects.toThrow(
    "cannot apply shell environment variable",
  );
});

test("isolates the restore slot across overlapping launches and ordinary subprocesses", async () => {
  if (!canRequestCursorShellEnvironment()) {
    await expect(prepareCursorShellEnvironment({ CUSTOM: "fixture" })).rejects.toThrow(
      "cannot apply agent-local shell environment",
    );
    return;
  }
  const script = [
    "export CUSTOM=login PASEO_AGENT_ID=stale CURSOR_API_KEY=synthetic;",
    'eval "${__CURSOR_SANDBOX_TEMP_RESTORE:-}";',
    'printf "%s\\0%s\\0%s" "$CUSTOM" "$PASEO_AGENT_ID" "${CURSOR_API_KEY:-}"',
  ].join(" ");
  const execute = async (value: string | undefined, detached: boolean) => {
    const env = value
      ? await prepareCursorShellEnvironment({ CUSTOM: value, PASEO_AGENT_ID: value })
      : undefined;
    // Bash supplies the same builtin export/unset commands used by SDK 1.4.2.
    const child = withCursorShellEnvironment(env, () =>
      spawn("bash", ["-c", script], {
        detached,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    const [exitCode] = await once(child, "close");
    expect(exitCode).toBe(0);
    return output.split("\0");
  };
  const one = "one '\n$(false)";
  const two = "two space";
  expect(
    await Promise.all([
      execute(one, true),
      execute(two, true),
      execute("mcp-like", false),
      execute(undefined, true),
    ]),
  ).toEqual([
    [one, one, ""],
    [two, two, ""],
    ["login", "stale", "synthetic"],
    ["login", "stale", "synthetic"],
  ]);
});

test("refuses settings for the pinned SDK's unsupported PowerShell or missing shell paths", async () => {
  for (const shell of ["/bin/pwsh", "/missing/bash"]) {
    vi.stubEnv("SHELL", shell);
    try {
      await expect(
        prepareCursorShellEnvironment({ PASEO_AGENT_ID: "daemon-generated" }),
      ).resolves.toBeUndefined();
      await expect(prepareCursorShellEnvironment({ PASEO_CLI: "/path/paseo" })).rejects.toThrow(
        "cannot apply agent-local shell environment",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  }
});
