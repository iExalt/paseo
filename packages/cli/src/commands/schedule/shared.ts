import type { DaemonTarget } from "../../utils/daemon-target.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  ScheduleDaemonClient,
  ScheduleListItem,
  ScheduleRecord,
  ScheduleCallerAgent,
  ScheduleTarget,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "./types.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";

export interface ScheduleCommandOptions extends CommandOptions {
  host?: string;
}

export type ScheduleCallerAgentFallback = ScheduleCallerAgent;

export async function connectScheduleClient(
  target: DaemonTarget,
): Promise<{ client: ScheduleDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ target });
  try {
    const client = (await connectToDaemon({
      target,
    })) as unknown as ScheduleDaemonClient;
    return { client, host: resolvedHost };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toScheduleCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export async function requireNewAgentSchedule(
  client: ScheduleDaemonClient,
  id: string,
): Promise<void> {
  const payload = await client.scheduleInspect({ id });
  if (payload.error || !payload.schedule || payload.schedule.target.type !== "new-agent") {
    throw new Error(payload.error ?? `Schedule not found: ${id}`);
  }
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") {
    const timezoneSuffix = cadence.timezone ? ` (${cadence.timezone})` : "";
    return `cron:${cadence.expression}${timezoneSuffix}`;
  }
  return `every:${formatDurationMs(cadence.everyMs)}`;
}

export function formatTarget(target: ScheduleTarget | ScheduleListItem["target"]): string {
  if (target.type === "self") {
    return `self:${target.agentId.slice(0, 7)}`;
  }
  if (target.type === "agent") {
    return `agent:${target.agentId.slice(0, 7)}`;
  }
  const modelSuffix = target.config.model ? `/${target.config.model}` : "";
  return `new-agent:${target.config.provider}${modelSuffix}`;
}

export function formatDurationMs(durationMs: number): string {
  const parts: string[] = [];
  let remainingMs = durationMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours > 0) {
    parts.push(`${hours}h`);
    remainingMs -= hours * 60 * 60 * 1000;
  }
  const minutes = Math.floor(remainingMs / (60 * 1000));
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remainingMs -= minutes * 60 * 1000;
  }
  const seconds = Math.floor(remainingMs / 1000);
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join("");
}

function resolveScheduleTarget(args: {
  targetValue: string | undefined;
  hasExplicitNewAgentOption: boolean;
  createNewAgentTarget: () => ScheduleTarget;
}): ScheduleTarget {
  const { targetValue, hasExplicitNewAgentOption, createNewAgentTarget } = args;
  if (!targetValue) {
    return createNewAgentTarget();
  }

  if (targetValue === "new-agent") {
    return createNewAgentTarget();
  }

  if (hasExplicitNewAgentOption) {
    throw {
      code: "INVALID_TARGET",
      message: "--provider/--mode/--thinking/--isolation can only be used with a new-agent target",
      details: "Use --target new-agent or omit --target to create a new agent schedule",
    } satisfies CommandError;
  }

  if (targetValue === "self") {
    // COMPAT(scheduleSelfTarget): heartbeat creation moved to `paseo heartbeat create`.
    // Added in v0.2.0; remove after 2027-01-17.
    const currentAgentId = process.env.PASEO_AGENT_ID?.trim();
    if (!currentAgentId) {
      throw {
        code: "INVALID_TARGET",
        message: "--target self requires running inside a Paseo agent",
      } satisfies CommandError;
    }
    return { type: "self", agentId: currentAgentId };
  }

  return { type: "agent", agentId: targetValue };
}

interface ScheduleCreateParseOptions {
  prompt: string;
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
  host?: string;
  callerAgent?: ScheduleCallerAgentFallback;
  replaceExisting?: boolean;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
}

interface NormalizedScheduleCreateOptions {
  prompt: string;
  cadence: ScheduleCadence;
  cwdInput?: string;
  modeId?: string;
  thinkingOptionId?: string;
  runOnCreate: boolean;
}

function validateScheduleCreateOptions(
  options: ScheduleCreateParseOptions,
): NormalizedScheduleCreateOptions {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw {
      code: "INVALID_PROMPT",
      message: "Schedule prompt cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  if (!cadence) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify exactly one of --every or --cron",
    } satisfies CommandError;
  }

  const cwdInput = options.cwd?.trim();
  if (options.daemonTarget.kind === "endpoint" && !cwdInput && !options.callerAgent) {
    throw {
      code: "MISSING_CWD",
      message:
        "--cwd is required when --host is specified (the local working directory will not exist on the remote daemon)",
    } satisfies CommandError;
  }

  if (options.provider !== undefined && !options.provider.trim()) {
    throw {
      code: "INVALID_PROVIDER",
      message: "--provider cannot be empty",
    } satisfies CommandError;
  }
  const modeId = options.mode?.trim();
  const thinkingOptionId = options.thinking?.trim();
  if (options.mode !== undefined && !modeId) {
    throw {
      code: "INVALID_MODE",
      message: "--mode cannot be empty",
    } satisfies CommandError;
  }
  if (options.thinking !== undefined && !thinkingOptionId) {
    throw {
      code: "INVALID_THINKING_OPTION",
      message: "--thinking cannot be empty",
    } satisfies CommandError;
  }
  return {
    prompt,
    cadence,
    ...(cwdInput ? { cwdInput } : {}),
    ...(modeId ? { modeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    runOnCreate: resolveRunOnCreate(options.runNow, cadence.type),
  };
}

function createInheritedNewAgentTarget(
  options: ScheduleCreateParseOptions,
  normalized: NormalizedScheduleCreateOptions,
): ScheduleTarget {
  const callerAgent = options.callerAgent;
  if (!callerAgent) throw new Error("Caller agent is required for inherited runtime");
  const resolvedOverride = options.provider
    ? resolveProviderAndModel({ provider: options.provider })
    : undefined;
  const provider = resolvedOverride?.provider ?? callerAgent.provider;
  const model =
    resolvedOverride?.model ?? (options.provider === undefined ? callerAgent.model : undefined);
  const modeId =
    normalized.modeId ??
    (callerAgent.provider === provider ? callerAgent.currentModeId : undefined);
  const thinkingOptionId = normalized.thinkingOptionId ?? callerAgent.thinkingOptionId;
  const cwd = normalized.cwdInput ?? callerAgent.cwd;
  return {
    type: "new-agent",
    config: {
      provider,
      cwd,
      ...(model ? { model } : {}),
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(options.isolation ? { isolation: options.isolation } : {}),
    },
  };
}

function createUnscopedNewAgentTarget(
  options: ScheduleCreateParseOptions,
  normalized: NormalizedScheduleCreateOptions,
): ScheduleTarget {
  const resolvedProviderModel = resolveProviderAndModel({ provider: options.provider });
  return {
    type: "new-agent",
    config: {
      provider: resolvedProviderModel.provider,
      cwd: normalized.cwdInput ?? process.cwd(),
      ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
      ...(normalized.modeId ? { modeId: normalized.modeId } : {}),
      ...(normalized.thinkingOptionId ? { thinkingOptionId: normalized.thinkingOptionId } : {}),
      ...(options.isolation ? { isolation: options.isolation } : {}),
    },
  };
}

function getScheduleCreateTarget(
  options: ScheduleCreateParseOptions,
  normalized: NormalizedScheduleCreateOptions,
): ScheduleTarget {
  const hasExplicitNewAgentOption =
    options.provider !== undefined ||
    options.mode !== undefined ||
    options.thinking !== undefined ||
    options.isolation !== undefined;
  const target = resolveScheduleTarget({
    targetValue: options.target?.trim(),
    hasExplicitNewAgentOption,
    createNewAgentTarget: () =>
      options.callerAgent
        ? createInheritedNewAgentTarget(options, normalized)
        : createUnscopedNewAgentTarget(options, normalized),
  });
  return target;
}

export function parseScheduleCreateInput(options: ScheduleCreateParseOptions): CreateScheduleInput {
  const normalized = validateScheduleCreateOptions(options);
  const target = getScheduleCreateTarget(options, normalized);

  const maxRuns =
    options.maxRuns === undefined ? undefined : parsePositiveInt(options.maxRuns, "--max-runs");
  if (options.expiresIn !== undefined) parseDuration(options.expiresIn);
  return {
    prompt: normalized.prompt,
    cadence: normalized.cadence,
    target,
    runOnCreate: normalized.runOnCreate,
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
    ...(options.callerAgent && target.type === "new-agent"
      ? {
          callerContext: {
            agentId: options.callerAgent.id,
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
            ...(normalized.cwdInput !== undefined ? { cwd: normalized.cwdInput } : {}),
            ...(normalized.modeId !== undefined ? { modeId: normalized.modeId } : {}),
            ...(normalized.thinkingOptionId !== undefined
              ? { thinkingOptionId: normalized.thinkingOptionId }
              : {}),
            ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
          },
        }
      : {}),
    ...(options.replaceExisting ? { replaceExisting: true } : {}),
  };
}

function resolveRunOnCreate(
  runNow: boolean | undefined,
  _cadenceType: ScheduleCadence["type"],
): boolean {
  return runNow ?? false;
}

export interface ScheduleUpdateOptionsInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  clearModel?: boolean;
  clearMode?: boolean;
  cwd?: string;
  maxRuns?: string;
  expiresIn?: string;
  clearMaxRuns?: boolean;
  clearExpires?: boolean;
}

export function parseScheduleUpdateInput(options: ScheduleUpdateOptionsInput): UpdateScheduleInput {
  const id = options.id.trim();
  if (!id) {
    throw {
      code: "INVALID_SCHEDULE_ID",
      message: "Schedule id cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  const newAgentConfig = buildNewAgentConfigPatch(options);
  const maxRuns = parseUpdateMaxRuns(options);
  const expiry = parseUpdateExpiry(options);
  const name = parseUpdateName(options);
  const prompt = parseUpdatePrompt(options);

  if (
    name === undefined &&
    prompt === undefined &&
    cadence === undefined &&
    newAgentConfig === undefined &&
    maxRuns === undefined &&
    expiry.expiresAt === undefined &&
    expiry.expiresIn === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "Specify at least one field to update",
    } satisfies CommandError;
  }

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(newAgentConfig !== undefined ? { newAgentConfig } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...expiry,
  };
}

function parseCadenceFromFlags(
  every: string | undefined,
  cron: string | undefined,
  timezone: string | undefined,
): ScheduleCadence | undefined {
  if (every !== undefined && cron !== undefined) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify at most one of --every or --cron",
    } satisfies CommandError;
  }
  const trimmedTimeZone = parseTimeZoneFlag(timezone);
  if (trimmedTimeZone !== undefined && cron === undefined) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone can only be used with --cron",
    } satisfies CommandError;
  }
  if (every !== undefined) {
    return { type: "cron", expression: compileEveryPresetToCron(every) };
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron.trim(),
      ...(trimmedTimeZone ? { timezone: trimmedTimeZone } : {}),
    };
  }
  return undefined;
}

export function compileEveryPresetToCron(value: string): string {
  const durationMs = parseDuration(value);
  const cron = everyMsToFiveFieldCron(durationMs);
  if (cron) {
    return cron;
  }

  throw {
    code: "UNREPRESENTABLE_CADENCE",
    message: `${value} cannot be represented faithfully by five-field cron`,
    details: "Use --cron for calendar schedules",
  } satisfies CommandError;
}

function parseTimeZoneFlag(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) {
    return undefined;
  }
  const trimmed = timeZone.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function parseUpdateMaxRuns(options: ScheduleUpdateOptionsInput): number | null | undefined {
  if (options.maxRuns !== undefined && options.clearMaxRuns) {
    throw {
      code: "CONFLICTING_MAX_RUNS",
      message: "Use either --max-runs <n> or --no-max-runs, not both",
    } satisfies CommandError;
  }
  if (options.clearMaxRuns) {
    return null;
  }
  if (options.maxRuns !== undefined) {
    return parsePositiveInt(options.maxRuns, "--max-runs");
  }
  return undefined;
}

function parseUpdateExpiry(options: ScheduleUpdateOptionsInput): {
  expiresAt?: null;
  expiresIn?: string;
} {
  if (options.expiresIn !== undefined && options.clearExpires) {
    throw {
      code: "CONFLICTING_EXPIRES",
      message: "Use either --expires-in <duration> or --no-expires-in, not both",
    } satisfies CommandError;
  }
  if (options.clearExpires) {
    return { expiresAt: null };
  }
  if (options.expiresIn !== undefined) {
    parseDuration(options.expiresIn);
    return { expiresIn: options.expiresIn };
  }
  return {};
}

function parseUpdateName(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.name === undefined) {
    return undefined;
  }
  const trimmed = options.name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUpdatePrompt(options: ScheduleUpdateOptionsInput): string | undefined {
  if (options.prompt === undefined) {
    return undefined;
  }
  const trimmed = options.prompt.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_PROMPT",
      message: "--prompt cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function buildNewAgentConfigPatch(
  options: ScheduleUpdateOptionsInput,
): UpdateScheduleNewAgentConfig | undefined {
  const patch: UpdateScheduleNewAgentConfig = {};
  if (options.clearModel && options.model !== undefined) {
    throw {
      code: "CONFLICTING_MODEL",
      message: "Use either --model <model> or --clear-model, not both",
    } satisfies CommandError;
  }
  if (options.clearMode && options.mode !== undefined) {
    throw {
      code: "CONFLICTING_MODE",
      message: "Use either --mode <mode> or --clear-mode, not both",
    } satisfies CommandError;
  }
  if (options.provider !== undefined) {
    if (options.clearModel && options.provider?.includes("/")) {
      throw {
        code: "CONFLICTING_MODEL",
        message: "--provider cannot include a model when --clear-model is used",
      } satisfies CommandError;
    }
    const resolved = resolveProviderAndModel({
      provider: options.provider,
      model: options.clearModel ? undefined : options.model,
    });
    patch.provider = resolved.provider;
    if (resolved.model !== undefined) {
      patch.model = resolved.model;
    }
  } else if (options.model !== undefined) {
    const model = options.model.trim();
    if (!model) {
      throw {
        code: "INVALID_MODEL",
        message: "--model cannot be empty",
      } satisfies CommandError;
    }
    patch.model = model;
  }
  if (options.clearModel) patch.model = null;
  if (options.clearMode) patch.modeId = null;
  if (options.mode !== undefined) {
    const trimmed = options.mode.trim();
    patch.modeId = trimmed.length > 0 ? trimmed : null;
  }
  if (options.cwd !== undefined) {
    const trimmed = options.cwd.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_CWD",
        message: "--cwd cannot be empty",
      } satisfies CommandError;
    }
    patch.cwd = trimmed;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a positive integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export interface ScheduleRow {
  id: string;
  name: string | null;
  cadence: string;
  target: string;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  schedule: ScheduleListItem | ScheduleRecord;
}

export function toScheduleRow(schedule: ScheduleListItem | ScheduleRecord): ScheduleRow {
  return {
    id: schedule.id,
    name: schedule.name,
    cadence: formatCadence(schedule.cadence),
    target: formatTarget(schedule.target),
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    schedule,
  };
}
