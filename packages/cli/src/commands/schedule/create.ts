import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  parseScheduleCreateInput,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export interface ScheduleCreateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  thinking?: string;
  isolation?: "local" | "worktree";
  cwd?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
  replace?: boolean;
}

export async function runCreateCommand(
  prompt: string,
  options: ScheduleCreateOptions,
  command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const runNowSource = command.getOptionValueSource("runNow");
  const runNow = runNowSource === "cli" ? Boolean(options.runNow) : undefined;
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const ambientCallerId = process.env.PASEO_AGENT_ID?.trim();
    const caller = ambientCallerId ? await client.fetchAgent({ agentId: ambientCallerId }) : null;
    const callerAgent = caller && caller.agent.id === ambientCallerId ? caller.agent : undefined;
    const input = parseScheduleCreateInput({
      prompt,
      every: options.every,
      cron: options.cron,
      timezone: options.timezone,
      name: options.name,
      target: options.target,
      provider: options.provider,
      mode: options.mode,
      thinking: options.thinking,
      isolation: options.isolation,
      cwd: options.cwd,
      callerAgent,
      daemonTarget: options.daemonTarget,
      maxRuns: options.maxRuns,
      expiresIn: options.expiresIn,
      runNow,
    });
    const payload = await client.scheduleCreate({
      ...input,
      ...(options.replace ? { replaceExisting: true } : {}),
    });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? "Schedule creation failed");
    }
    return {
      type: "single",
      data: toScheduleRow(payload.schedule),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_CREATE_FAILED", "create schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
