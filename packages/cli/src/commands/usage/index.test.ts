import { Command } from "commander";
import { runSpendCommand } from "./spend.js";
import { describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema, type UsageReportEntry } from "@getpaseo/protocol/messages";
import { render } from "../../output/index.js";
import { createCli } from "../../cli.js";
import { runUsageCommand } from "./index.js";

const options = { daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" } };
const reports: UsageReportEntry[] = [
  {
    id: "plugin.source:work.account",
    sourceId: "plugin.source",
    sourceLabel: "Plugin Source",
    account: { label: "Work" },
    fetchedAt: "2026-10-09T12:00:00Z",
    icon: "<svg />",
    report: {
      status: "available",
      planLabel: "Pro",
      windows: [
        {
          id: "5h",
          label: "Five hours",
          usedPct: 12.5,
          remainingPct: 87.5,
          resetsAt: "2026-10-09T17:00:00Z",
          runsOutAt: "2026-10-09T16:00:00Z",
          shortfallPct: 4.25,
        },
        { id: "week", label: "Weekly", usedPct: null, remainingPct: 0 },
        { id: "extra", label: "Extra", usedPct: 0 },
      ],
      balances: [
        {
          id: "credit",
          label: "Credit",
          used: 0,
          remaining: 2.5,
          limit: 10,
          unit: "usd",
          resetsAt: "2026-11-01T00:00:00Z",
        },
        { id: "requests", label: "Requests", remaining: null, unit: "requests" },
      ],
      details: [{ id: "tier", label: "Tier", value: "Enterprise" }],
    },
  },
  {
    id: "plugin.source:personal",
    sourceId: "plugin.source",
    sourceLabel: "Plugin Source",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: {
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "codex login" },
    },
    loginErrors: [
      {
        harness: "Claude Code",
        report: {
          status: "unavailable",
          problem: { kind: "expired", expiresAt: "2026-10-08T00:00:00Z", refreshedBy: "claude" },
        },
      },
      {
        harness: "Codex",
        report: {
          status: "unavailable",
          problem: { kind: "rejected", status: 401, refreshedBy: "codex login" },
        },
      },
      { harness: "Other", report: { status: "error", error: "Login service failed" } },
    ],
  },
  {
    id: "other:broken",
    sourceId: "other",
    sourceLabel: "Other",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: { status: "error", error: "Source failed" },
  },
  {
    id: "other:noquota",
    sourceId: "other",
    sourceLabel: "Other",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: {
      status: "unavailable",
      problem: { kind: "no_quota", detail: "No quota for this plan" },
    },
  },
];

function host(entries = reports, supported = true) {
  const requests: Array<Parameters<NonNullable<Parameters<typeof runUsageCommand>[2]>>[0]> = [];
  const queries: Array<
    { agentId?: string; forceRefresh?: boolean; reportIds?: string[] } | undefined
  > = [];
  const agent = AgentSnapshotPayloadSchema.parse({
    id: "agent-123",
    provider: "claude",
    cwd: "/workspace",
    model: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Caller",
    labels: {},
    runtimeInfo: { provider: "claude", sessionId: "thread-123" },
  });
  const agentLookups: string[] = [];
  let closed = 0;
  return {
    requests,
    queries,
    agentLookups,
    get closed() {
      return closed;
    },
    connect: async (input: (typeof requests)[number]) => {
      requests.push(input);
      return {
        getLastServerInfoMessage: () => ({ features: { usageSources: supported } }),
        listUsageReports: async (query?: (typeof queries)[number]) => {
          queries.push(query);
          const selected = query?.reportIds
            ? entries.filter((entry) => query.reportIds!.includes(entry.id))
            : entries;
          return { requestId: "request", reports: selected };
        },
        fetchAgent: async (target: string | { agentId: string }) => {
          const agentId = typeof target === "string" ? target : target.agentId;
          agentLookups.push(agentId);
          return agentId === agent.id || agentId === agent.runtimeInfo?.sessionId
            ? { agent, project: null }
            : null;
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
}

it("preserves complete JSON entries, numeric values and quiet full IDs", async () => {
  const daemon = host();
  const result = await runUsageCommand(options, { kind: "list" }, daemon.connect);
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(reports);
  expect(render(result, { quiet: true })).toBe(reports.map((entry) => entry.id).join("\n"));
  expect(daemon.requests).toEqual([{ target: options.daemonTarget }]);
  expect(daemon.closed).toBe(1);
});

it("lists all windows, balances, missing values, failures and remedies", async () => {
  const result = await runUsageCommand(options, { kind: "list" }, host().connect);
  const text = render(result, { noColor: true });
  for (const expected of [
    "REPORT ID",
    "SOURCE",
    "ACCOUNT",
    "STATUS",
    "USAGE",
    "FETCHED",
    "Five hours: 12.5% used, 87.5% remaining",
    "Weekly: - used, 0% remaining",
    "Extra: 0% used, - remaining",
    "Credit: 0 used, 2.5 remaining, 10 limit (usd)",
    "Requests: - used, - remaining, - limit (requests)",
    "Login expired at 2026-10-08T00:00:00Z. Run claude",
    "Login rejected (HTTP 401). Run codex login",
    "Other: Login service failed",
    "Source failed",
    "No quota for this plan",
  ])
    expect(text).toContain(expected);
  expect(render(result, { noHeaders: true })).not.toContain("REPORT ID");
});

it("inspects exact opaque IDs and includes resets, forecasts, details and login failures", async () => {
  const daemon = host();
  const result = await runUsageCommand(
    options,
    { kind: "inspect", id: reports[0]!.id },
    daemon.connect,
  );
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(reports[0]);
  const text = render(result);
  for (const expected of [
    "Source ID: plugin.source",
    "Plan: Pro",
    "Resets: 2026-10-09T17:00:00Z",
    "Runs out: 2026-10-09T16:00:00Z",
    "Shortfall: 4.25%",
    "Resets: -",
    "Resets: 2026-11-01T00:00:00Z",
    "Tier: Enterprise",
  ])
    expect(text).toContain(expected);
  const failure = await runUsageCommand(
    options,
    { kind: "inspect", id: reports[1]!.id },
    daemon.connect,
  );
  expect(render(failure)).toContain("Login failures:\n  Claude Code: Login expired at");
  expect(render(failure)).toContain("  Other: Login service failed");
});

it("discovers before inspecting, then refreshes only the selected report", async () => {
  const daemon = host();
  await runUsageCommand(
    { ...options, refresh: true },
    { kind: "inspect", id: reports[0]!.id },
    daemon.connect,
  );
  expect(daemon.queries).toEqual([undefined, { reportIds: [reports[0]!.id], forceRefresh: true }]);
});

it("rejects agent selection combined with inspect before connecting", async () => {
  const daemon = host();
  await expect(
    runUsageCommand(
      { ...options, agent: "agent-A" },
      { kind: "inspect", id: reports[0]!.id },
      daemon.connect,
    ),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  expect(daemon.requests).toEqual([]);
});

it("passes agent account selection and refresh without converting it to token consumption", async () => {
  const daemon = host();
  await runUsageCommand(
    { ...options, agent: "agent-123", refresh: true },
    { kind: "list" },
    daemon.connect,
  );
  expect(daemon.agentLookups).toEqual(["agent-123"]);
  expect(daemon.queries).toEqual([{ agentId: "agent-123", forceRefresh: true }]);
});

it("selects the agent's account by its full session ID", async () => {
  const daemon = host();
  await runUsageCommand({ ...options, agent: "thread-123" }, { kind: "list" }, daemon.connect);
  expect(daemon.queries).toEqual([{ agentId: "agent-123", forceRefresh: undefined }]);
});

it("returns an empty array in JSON and explains empty discovery in human output", async () => {
  const result = await runUsageCommand(options, { kind: "list" }, host([]).connect);
  expect(render(result, { format: "json" })).toBe("[]");
  expect(render(result)).toBe("No usage reports returned");
  expect(render(result, { quiet: true })).toBe("");
});

it("rejects unknown IDs and prefixes and closes the client", async () => {
  const daemon = host();
  await expect(
    runUsageCommand(options, { kind: "inspect", id: "plugin.source:work" }, daemon.connect),
  ).rejects.toEqual({
    code: "REPORT_NOT_FOUND",
    message: "Unknown usage report: plugin.source:work",
  });
  expect(daemon.closed).toBe(1);
});

it("gates unsupported hosts before any request and closes the connection", async () => {
  const daemon = host(reports, false);
  await expect(runUsageCommand(options, { kind: "list" }, daemon.connect)).rejects.toMatchObject({
    code: "UNSUPPORTED_HOST",
  });
  expect(daemon.queries).toEqual([]);
  expect(daemon.closed).toBe(1);
});

it("propagates connection and request failures", async () => {
  await expect(
    runUsageCommand(options, { kind: "list" }, async () => {
      throw new Error("Connection failed");
    }),
  ).rejects.toThrow("Connection failed");
  let closed = false;
  const connect = async () => ({
    getLastServerInfoMessage: () => ({ features: { usageSources: true } }),
    listUsageReports: async () => {
      throw new Error("Request failed");
    },
    close: async () => {
      closed = true;
    },
  });
  await expect(runUsageCommand(options, { kind: "list" }, connect)).rejects.toThrow(
    "Request failed",
  );
  expect(closed).toBe(true);
});

describe("usage CLI registration", () => {
  it("registers default, ls and inspect with the accepted selectors", () => {
    const usage = createCli().commands.find((command) => command.name() === "usage")!;
    expect(usage.commands.map((command) => command.name())).toEqual(["ls", "inspect", "spend"]);
    expect(usage.helpInformation()).toContain("--agent <id>");
    expect(usage.commands[0]!.helpInformation()).toContain("--refresh");
    expect(usage.commands[1]!.helpInformation()).toContain("<report-id>");
  });
});

it("shows retained values with current failures and separates successful time from latest attempt", async () => {
  const success: UsageReportEntry = { ...reports[0]!, successfulAt: "2026-10-09T12:00:15Z" };
  const current = await runUsageCommand(
    options,
    { kind: "inspect", id: success.id },
    host([success]).connect,
  );
  expect(render(current)).toContain("Latest attempt: 2026-10-09T12:00:00Z");
  expect(render(current)).toContain("Last successful: 2026-10-09T12:00:15Z");
  const currentList = await runUsageCommand(options, { kind: "list" }, host([success]).connect);
  expect(render(currentList)).toContain("Last successful: 2026-10-09T12:00:15Z");
  if (success.report.status !== "available") throw new Error("fixture must be available");
  const retained: UsageReportEntry = {
    ...success,
    fetchedAt: "2026-10-09T12:06:00Z",
    report: { status: "error", error: "Rate limited" },
    successfulAt: undefined,
    lastSuccessful: { fetchedAt: success.successfulAt!, report: success.report },
  };
  const daemon = host([retained]);
  const listed = await runUsageCommand(options, { kind: "list" }, daemon.connect);
  expect(render(listed)).toContain("Retained: Five hours: 12.5% used");
  expect(render(listed)).toContain("Last successful: 2026-10-09T12:00:15Z");
  expect(render(listed)).toContain("Rate limited");
  expect(JSON.parse(render(listed, { format: "json" }))).toEqual([retained]);
  const inspected = await runUsageCommand(
    options,
    { kind: "inspect", id: retained.id },
    daemon.connect,
  );
  expect(render(inspected)).toContain("Latest attempt: 2026-10-09T12:06:00Z");
  expect(render(inspected)).toContain("Last successful: 2026-10-09T12:00:15Z");
  expect(render(inspected)).toContain("Retained usage:");
  expect(render(inspected)).toContain("Five hours: 12.5% used");
  expect(render(inspected)).toContain("Reason: Rate limited");
});

describe("host spend", () => {
  it("preserves canonical spend including carry and forwards the time zone", async () => {
    let closed = false;
    const summary = {
      trackingSince: "2026-11-01T00:00:00Z",
      providers: [
        {
          provider: "codex",
          todayUsd: 0.123456,
          last7DaysUsd: 2,
          thisMonthUsd: 3,
          allTimeUsd: 8,
          carriedUsd: 5,
        },
      ],
    };
    const result = await runSpendCommand(
      { daemonTarget: { kind: "endpoint", host: "host:1234" }, timeZone: "America/Toronto" },
      new Command(),
      async (connectionOptions) => {
        expect(connectionOptions.target).toEqual({ kind: "endpoint", host: "host:1234" });
        return {
          getLastServerInfoMessage: () => ({
            status: "server_info",
            serverId: "host",
            features: { usageSpendSummary: true },
          }),
          getSpendSummary: async (request) => {
            expect(request).toEqual({ timeZone: "America/Toronto" });
            return { requestId: "spend", summary };
          },
          close: async () => {
            closed = true;
          },
        };
      },
    );
    expect(result.data).toBe(summary);
    expect(closed).toBe(true);
  });
  it("rejects invalid zones before connection and gates unsupported hosts", async () => {
    let called = false;
    const connect = async () => {
      called = true;
      throw new Error("must not connect");
    };
    const spendOptions = { daemonTarget: { kind: "endpoint" as const, host: "host:1234" } };
    await expect(
      runSpendCommand({ ...spendOptions, timeZone: "Invalid/Zone" }, new Command(), connect),
    ).rejects.toMatchObject({ code: "INVALID_TIME_ZONE" });
    expect(called).toBe(false);
    let closed = false;
    await expect(
      runSpendCommand(spendOptions, new Command(), async () => ({
        getLastServerInfoMessage: () => null,
        getSpendSummary: async () => {
          throw new Error("must not request");
        },
        close: async () => {
          closed = true;
        },
      })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HOST" });
    expect(closed).toBe(true);
  });
});

it("spend renders an empty ledger and rejects inherited selectors", async () => {
  const spendOptions = { daemonTarget: { kind: "endpoint" as const, host: "host:1234" } };
  const result = await runSpendCommand(spendOptions, new Command(), async () => ({
    getLastServerInfoMessage: () => ({
      status: "server_info",
      serverId: "host",
      features: { usageSpendSummary: true },
    }),
    getSpendSummary: async () => ({
      requestId: "empty",
      summary: { trackingSince: null, providers: [] },
    }),
    close: async () => {},
  }));
  expect(result.data).toEqual({ trackingSince: null, providers: [] });
  expect(
    render(result, { format: "table", quiet: false, noHeaders: false, noColor: true }),
  ).toContain("No spend recorded");
  for (const extra of [{ agent: "a" }, { refresh: true }]) {
    await expect(
      runSpendCommand({ ...spendOptions, ...extra }, new Command(), async () => {
        throw new Error("must not connect");
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  }
});

it("parses spend with a host and JSON output", async () => {
  const program = createCli().exitOverride();
  const usage = program.commands.find((command) => command.name() === "usage")!;
  const spend = usage.commands.find((command) => command.name() === "spend")!;
  let selected: unknown;
  spend.action((_commandOptions, parsedCommand: Command) => {
    selected = parsedCommand.optsWithGlobals();
  });
  await program.parseAsync(
    ["usage", "spend", "--host", "host:1234", "--json", "--time-zone", "UTC"],
    { from: "user" },
  );
  expect(selected).toMatchObject({ host: "host:1234", json: true, timeZone: "UTC" });
});
