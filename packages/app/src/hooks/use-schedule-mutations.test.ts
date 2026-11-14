import { QueryClient } from "@tanstack/react-query";
import type { ScheduleSummary, ScheduleRun } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import type {
  AggregatedSchedule,
  FetchAggregatedSchedulesResult,
  FetchAggregatedSchedulesState,
} from "@/schedules/aggregated-schedules";
import { schedulesQueryBaseKey } from "@/schedules/aggregated-schedules";
import {
  requireSuccessfulScheduleRun,
  updateAggregatedSchedulesData,
} from "./use-schedule-mutations";

function schedule(overrides: Partial<AggregatedSchedule> = {}): AggregatedSchedule {
  const base: ScheduleSummary = {
    id: "schedule-1",
    name: "Nightly",
    prompt: "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp/project" } },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: "2026-07-02T01:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
  };
  return { ...base, serverId: "host-a", serverName: "Host A", ...overrides };
}

function pauseSchedules(schedules: AggregatedSchedule[]): AggregatedSchedule[] {
  return schedules.map((entry) => ({ ...entry, status: "paused" }));
}

describe("manual schedule run results", () => {
  const run: ScheduleRun = {
    id: "run-1",
    scheduledFor: "2026-07-01T00:00:00Z",
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:01Z",
    status: "failed",
    agentId: null,
    output: null,
    error: "Target agent unavailable",
  };
  const payload = (runs: ScheduleRun[]) => ({
    requestId: "request-1",
    error: null,
    schedule: { ...schedule(), runs },
  });

  it("surfaces recorded execution failures even when the RPC succeeds", () => {
    expect(() => requireSuccessfulScheduleRun(payload([run]))).toThrow("Target agent unavailable");
  });

  it("uses the latest run, allowing a successful retry after a failure", () => {
    expect(() =>
      requireSuccessfulScheduleRun(
        payload([run, { ...run, id: "run-2", status: "succeeded", error: null }]),
      ),
    ).not.toThrow();
  });

  it("rejects RPC errors and missing results", () => {
    expect(() =>
      requireSuccessfulScheduleRun({
        requestId: "request-1",
        error: "Already running",
        schedule: null,
      }),
    ).toThrow("Already running");
    expect(() => requireSuccessfulScheduleRun(payload([]))).toThrow(
      "did not complete successfully",
    );
  });
});

function pauseAggregatedSchedules(
  current: FetchAggregatedSchedulesState | undefined,
): FetchAggregatedSchedulesState | undefined {
  return updateAggregatedSchedulesData(current, pauseSchedules);
}

describe("schedule mutation cache updates", () => {
  it("updates the canonical loaded data field", () => {
    const current: FetchAggregatedSchedulesResult = {
      status: "loaded",
      data: [schedule()],
      hostErrors: [],
    };

    const result = updateAggregatedSchedulesData(current, pauseSchedules);

    expect(result).toEqual({
      status: "loaded",
      data: [schedule({ status: "paused" })],
      hostErrors: [],
    });
  });

  it("leaves an empty cache entry empty", () => {
    const result = updateAggregatedSchedulesData(undefined, () => [schedule()]);

    expect(result).toBeUndefined();
  });

  it("leaves connecting cache entries untouched while updating loaded entries", () => {
    const queryClient = new QueryClient();
    const connectingKey = [...schedulesQueryBaseKey, "connecting"];
    const loadedKey = [...schedulesQueryBaseKey, "loaded"];
    const connecting = { status: "connecting" } as const;
    const loaded: FetchAggregatedSchedulesResult = {
      status: "loaded",
      data: [schedule()],
      hostErrors: [],
    };
    queryClient.setQueryData(connectingKey, connecting);
    queryClient.setQueryData(loadedKey, loaded);

    expect(() => {
      queryClient.setQueriesData<FetchAggregatedSchedulesState>(
        { queryKey: schedulesQueryBaseKey },
        pauseAggregatedSchedules,
      );
    }).not.toThrow();

    expect(queryClient.getQueryData(connectingKey)).toEqual(connecting);
    expect(queryClient.getQueryData(loadedKey)).toEqual({
      status: "loaded",
      data: [schedule({ status: "paused" })],
      hostErrors: [],
    });
  });
});
