import { describe, expect, test } from "vitest";

import { selectDaemonTarget } from "../../utils/daemon-target.js";

import {
  compileEveryPresetToCron,
  parseScheduleCreateInput,
  parseScheduleUpdateInput,
} from "./shared.js";

const baseOptions = {
  daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
  prompt: "do the thing",
  every: "5m",
  provider: "claude",
};

const baseCron = {
  daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
  prompt: "do the thing",
  cron: "0 9 * * *",
  provider: "claude",
};

describe("parseScheduleCreateInput cwd/host validation", () => {
  test("no host, no cwd → defaults to process.cwd()", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: process.cwd() },
    });
  });

  test("no host, with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, cwd: "/some/other/path" });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/some/other/path" },
    });
  });

  test("host with cwd → uses provided cwd", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      cwd: "/remote/project",
    });
    expect(input.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/remote/project" },
    });
  });

  test("host without cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required when --host is specified"),
      }),
    );
  });

  test("PASEO_HOST without cwd → throws MISSING_CWD", () => {
    const daemonTarget = selectDaemonTarget({}, { PASEO_HOST: "dev:12345" });

    expect(() => parseScheduleCreateInput({ ...baseOptions, daemonTarget })).toThrow(
      expect.objectContaining({
        code: "MISSING_CWD",
        message: expect.stringContaining("--cwd is required"),
      }),
    );
  });

  test("explicit home beats PASEO_HOST and defaults cwd locally", () => {
    const daemonTarget = selectDaemonTarget({ home: process.cwd() }, { PASEO_HOST: "dev:12345" });
    expect(parseScheduleCreateInput({ ...baseOptions, daemonTarget }).target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: process.cwd() },
    });
  });

  test("host with whitespace-only cwd → throws MISSING_CWD", () => {
    expect(() =>
      parseScheduleCreateInput({
        ...baseOptions,
        daemonTarget: selectDaemonTarget({ host: "dev:12345" }, {}),
        cwd: "   ",
      }),
    ).toThrow(expect.objectContaining({ code: "MISSING_CWD" }));
  });
});

describe("parseScheduleCreateInput first-run timing", () => {
  test("--every compiles to cron and waits for the next slot", () => {
    const input = parseScheduleCreateInput(baseOptions);
    expect(input.cadence).toEqual({ type: "cron", expression: "*/5 * * * *" });
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with no run-now flag waits for the next cron slot", () => {
    const input = parseScheduleCreateInput(baseCron);
    expect(input.runOnCreate).toBe(false);
  });

  test("--cron with --run-now fires immediately on creation", () => {
    const input = parseScheduleCreateInput({ ...baseCron, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--cron with --timezone stores a timezone-aware cadence", () => {
    const input = parseScheduleCreateInput({
      ...baseCron,
      timezone: "  America/New_York  ",
    });

    expect(input.cadence).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("--run-now is orthogonal to a compiled preset", () => {
    const input = parseScheduleCreateInput({ ...baseOptions, runNow: true });
    expect(input.runOnCreate).toBe(true);
  });

  test("--timezone without --cron is rejected", () => {
    expect(() => parseScheduleCreateInput({ ...baseOptions, timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({
        code: "INVALID_TIME_ZONE",
        message: "--timezone can only be used with --cron",
      }),
    );
  });
});

describe("parseScheduleCreateInput caller inheritance and isolation", () => {
  const callerAgent = {
    id: "caller-agent",
    provider: "codex",
    cwd: "/daemon/caller",
    model: "gpt-5.4",
    currentModeId: "plan",
    thinkingOptionId: "high",
  };

  test("uses caller values only as fallback and sends only explicit overrides", () => {
    const input = parseScheduleCreateInput({
      daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
      prompt: "run",
      cron: "0 9 * * *",
      callerAgent,
      isolation: "worktree",
    });

    expect(input.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: "/daemon/caller",
        model: "gpt-5.4",
        modeId: "plan",
        thinkingOptionId: "high",
        isolation: "worktree",
      },
    });
    expect(input.callerContext).toEqual({
      agentId: "caller-agent",
      isolation: "worktree",
    });
  });

  test("an explicit provider/model and cwd are preserved as caller overrides", () => {
    const input = parseScheduleCreateInput({
      daemonTarget: selectDaemonTarget({ home: process.cwd() }, {}),
      prompt: "run",
      cron: "0 9 * * *",
      callerAgent,
      provider: "claude/sonnet",
      cwd: "/override",
    });

    expect(input.callerContext).toEqual({
      agentId: "caller-agent",
      provider: "claude/sonnet",
      cwd: "/override",
    });
    expect(input.target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/override",
        model: "sonnet",
        thinkingOptionId: "high",
      },
    });
  });
});

describe("parseScheduleCreateInput parity fields", () => {
  test("preserves isolation, daemon-relative expiry, and explicit replacement", () => {
    expect(
      parseScheduleCreateInput({
        ...baseCron,
        isolation: "worktree",
        expiresIn: "1h",
        replaceExisting: true,
      }),
    ).toMatchObject({
      target: {
        type: "new-agent",
        config: { isolation: "worktree" },
      },
      expiresIn: "1h",
    });
  });
});

describe("parseScheduleCreateInput thinking", () => {
  test("sets the thinking option for each scheduled new-agent run", () => {
    const input = parseScheduleCreateInput({
      ...baseOptions,
      cwd: "/project",
      thinking: "  high  ",
    });

    expect(input.target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/project",
        thinkingOptionId: "high",
      },
    });
  });
});

describe("parseScheduleUpdateInput", () => {
  test("rejects calls with no fields to update", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc" })).toThrow(
      expect.objectContaining({ code: "NO_UPDATES" }),
    );
  });

  test("parses prompt and name updates", () => {
    expect(parseScheduleUpdateInput({ id: "abc", prompt: "  hello  ", name: "  named  " })).toEqual(
      {
        id: "abc",
        name: "named",
        prompt: "hello",
      },
    );
  });

  test("name set to empty string clears the name", () => {
    expect(parseScheduleUpdateInput({ id: "abc", name: "" })).toEqual({
      id: "abc",
      name: null,
    });
  });

  test("rejects empty prompt", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", prompt: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_PROMPT" }),
    );
  });

  test("compiles --every cadence to cron", () => {
    expect(parseScheduleUpdateInput({ id: "abc", every: "5m" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "*/5 * * * *" },
    });
  });

  test("parses --cron cadence", () => {
    expect(parseScheduleUpdateInput({ id: "abc", cron: "30 9 * * *" })).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
  });

  test("parses --cron cadence with --timezone", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        cron: "30 9 * * *",
        timezone: "Europe/Zurich",
      }),
    ).toEqual({
      id: "abc",
      cadence: { type: "cron", expression: "30 9 * * *", timezone: "Europe/Zurich" },
    });
  });

  test("rejects passing both --every and --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", every: "5m", cron: "0 9 * * *" })).toThrow(
      expect.objectContaining({ code: "INVALID_CADENCE" }),
    );
  });

  test("rejects --timezone without --cron", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", timezone: "Europe/Zurich" })).toThrow(
      expect.objectContaining({ code: "INVALID_TIME_ZONE" }),
    );
  });

  test("parses provider/model shorthand and explicit mode", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        provider: "codex/gpt-5",
        mode: "full-access",
        cwd: "/tmp/proj",
      }),
    ).toEqual({
      id: "abc",
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        cwd: "/tmp/proj",
      },
    });
  });

  test("model-only patches do not invent a provider", () => {
    expect(parseScheduleUpdateInput({ id: "abc", model: "  opus  " })).toEqual({
      id: "abc",
      newAgentConfig: { model: "opus" },
    });
  });

  test("provider-only patches preserve an omitted model", () => {
    expect(parseScheduleUpdateInput({ id: "abc", provider: "claude" })).toEqual({
      id: "abc",
      newAgentConfig: { provider: "claude" },
    });
  });

  test("provider/model shorthand still rejects conflicting explicit models", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", provider: "claude/sonnet", model: "opus" }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_MODEL_OPTIONS" }));
  });

  test("rejects an empty model-only patch", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", model: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_MODEL" }),
    );
  });

  test("--mode with empty value clears the modeId", () => {
    expect(parseScheduleUpdateInput({ id: "abc", mode: "" })).toEqual({
      id: "abc",
      newAgentConfig: { modeId: null },
    });
  });

  test("rejects empty --cwd", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", cwd: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_CWD" }),
    );
  });

  test("--max-runs sets a positive integer; --no-max-runs clears", () => {
    expect(parseScheduleUpdateInput({ id: "abc", maxRuns: "3" })).toEqual({
      id: "abc",
      maxRuns: 3,
    });
    expect(parseScheduleUpdateInput({ id: "abc", clearMaxRuns: true })).toEqual({
      id: "abc",
      maxRuns: null,
    });
  });

  test("rejects passing both --max-runs and --no-max-runs", () => {
    expect(() => parseScheduleUpdateInput({ id: "abc", maxRuns: "3", clearMaxRuns: true })).toThrow(
      expect.objectContaining({ code: "CONFLICTING_MAX_RUNS" }),
    );
  });

  test("--expires-in stays relative for daemon-side clocking; --no-expires-in clears", () => {
    expect(parseScheduleUpdateInput({ id: "abc", expiresIn: "1h" })).toEqual({
      id: "abc",
      expiresIn: "1h",
    });

    expect(parseScheduleUpdateInput({ id: "abc", clearExpires: true })).toEqual({
      id: "abc",
      expiresAt: null,
    });
  });

  test("rejects passing both --expires-in and --no-expires-in", () => {
    expect(() =>
      parseScheduleUpdateInput({ id: "abc", expiresIn: "1h", clearExpires: true }),
    ).toThrow(expect.objectContaining({ code: "CONFLICTING_EXPIRES" }));
  });

  test("--clear-model and --clear-mode send explicit null patches", () => {
    expect(
      parseScheduleUpdateInput({
        id: "abc",
        provider: "claude",
        clearModel: true,
        clearMode: true,
      }),
    ).toEqual({
      id: "abc",
      newAgentConfig: { provider: "claude", model: null, modeId: null },
    });
  });
});

describe("compileEveryPresetToCron", () => {
  test.each([
    ["1m", "*/1 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["6h", "0 */6 * * *"],
    ["1d", "0 0 * * *"],
  ])("compiles %s", (value, expected) => {
    expect(compileEveryPresetToCron(value)).toBe(expected);
  });

  test.each(["30s", "7m", "5h", "2d"])("rejects rolling interval %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow(
      expect.objectContaining({ code: "UNREPRESENTABLE_CADENCE" }),
    );
  });

  test.each(["15minutes", "junk15m", "1h-nope"])("rejects malformed preset %s", (value) => {
    expect(() => compileEveryPresetToCron(value)).toThrow("Invalid duration format");
  });
});
