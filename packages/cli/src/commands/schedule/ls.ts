import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  matchesScheduleStatus,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export async function runLsCommand(
  options: ScheduleCommandOptions & { status?: "active" | "ended" | "all" },
  _command: Command,
): Promise<ListResult<ScheduleRow>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const payload = await client.scheduleList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    const now = Date.now();
    return {
      type: "list",
      data: payload.schedules
        .filter(
          (schedule) =>
            schedule.target.type === "new-agent" &&
            matchesScheduleStatus(schedule, options.status, now),
        )
        .map(toScheduleRow),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_LIST_FAILED", "list schedules", error);
  } finally {
    await client.close().catch(() => {});
  }
}
