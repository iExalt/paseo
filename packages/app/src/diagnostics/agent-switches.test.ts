import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(flag: string | undefined, launch: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_PASEO_AGENT_SWITCHES", flag ?? "");
  const takeLaunchSwitches = vi.fn(() => launch);
  vi.doMock("./agent-switches-source", () => ({
    takeLaunchSwitches,
    addSwitchesListener: vi.fn(),
  }));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const switches = await import("./agent-switches");
  const trace = await import("@/terminal/native-renderer/terminal-input-trace");
  return { switches, trace, info, takeLaunchSwitches };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("./agent-switches-source");
});

describe("agent switches", () => {
  it("ignores launch switches in a build without the flag", async () => {
    const { switches, trace, info, takeLaunchSwitches } = await loadWith(undefined, {
      trace: "terminal-input",
    });
    switches.loadAgentSwitches();

    expect(switches.readAgentSwitch("trace")).toBeUndefined();
    expect(trace.isTerminalTraceEnabled()).toBe(false);
    expect(takeLaunchSwitches).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("has the launch switches on the first read and logs each one", async () => {
    const { switches, trace, info } = await loadWith("1", {
      trace: "terminal-input",
      colour: "blue",
    });

    expect(switches.readAgentSwitch("trace")).toBe("terminal-input");
    expect(trace.isTerminalTraceEnabled()).toBe(true);
    const lines = info.mock.calls.map(([line]) => line);
    expect(lines).toContain("[paseo-agent] debug set key=trace value=terminal-input");
    expect(lines).toContain("[paseo-agent] debug rejected key=colour reason=unknown-key");
  });

  it("clears a switch with off and skips values outside the allowlist", async () => {
    const { switches, trace } = await loadWith("1", { trace: "terminal-input" });

    switches.applyAgentSwitches({ trace: "everything" });
    expect(switches.readAgentSwitch("trace")).toBe("terminal-input");
    switches.applyAgentSwitches({ trace: "off" });
    expect(switches.readAgentSwitch("trace")).toBeUndefined();
    expect(trace.isTerminalTraceEnabled()).toBe(false);
  });
});

describe("the Android switch source", () => {
  it("takes pending switches at load and once more per native event", async () => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_PASEO_AGENT_SWITCHES", "1");
    const pending = [{ trace: "terminal-input" }, {}, { trace: "off" }];
    const takePendingSwitches = vi.fn(() => pending.shift() ?? {});
    let onSwitches: () => void = () => {};
    vi.doMock("expo-modules-core", () => ({
      requireOptionalNativeModule: () => ({
        takePendingSwitches,
        addListener: (_event: string, handler: () => void) => {
          onSwitches = handler;
          return { remove: () => {} };
        },
      }),
    }));
    vi.doMock("./agent-switches-source", () => import("./agent-switches-source.native"));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const switches = await import("./agent-switches");

    switches.loadAgentSwitches();
    expect(takePendingSwitches).toHaveBeenCalledTimes(1);
    expect(switches.readAgentSwitch("trace")).toBe("terminal-input");

    onSwitches();
    expect(takePendingSwitches).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledTimes(1);

    onSwitches();
    expect(takePendingSwitches).toHaveBeenCalledTimes(3);
    expect(switches.readAgentSwitch("trace")).toBeUndefined();
    vi.doUnmock("expo-modules-core");
  });
});
