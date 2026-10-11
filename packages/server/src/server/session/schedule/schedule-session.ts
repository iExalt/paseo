import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import { resolveNewAgentScheduleTarget } from "../../schedule/caller-runtime.js";
import { scheduleExpiryFromDuration } from "../../schedule/expiry.js";
import type { ScheduleService } from "../../schedule/service.js";
import type { ScheduleTarget } from "@getpaseo/protocol/schedule/types";

export interface ScheduleSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ScheduleSessionOptions {
  host: ScheduleSessionHost;
  scheduleService: ScheduleService;
  agentManager: AgentManager;
  logger: pino.Logger;
}

export class ScheduleSession {
  private readonly host: ScheduleSessionHost;
  private readonly scheduleService: ScheduleService;
  private readonly agentManager: AgentManager;
  private readonly logger: pino.Logger;

  constructor(options: ScheduleSessionOptions) {
    this.host = options.host;
    this.scheduleService = options.scheduleService;
    this.agentManager = options.agentManager;
    this.logger = options.logger;
  }

  private requireCallerAgent(agentId: string) {
    const callerAgent = this.agentManager.getAgent(agentId);
    if (!callerAgent) throw new Error(`Caller agent ${agentId} not found`);
    return callerAgent;
  }

  private async requireOwnedHeartbeat(scheduleId: string, callerAgentId: string): Promise<void> {
    const callerAgent = this.requireCallerAgent(callerAgentId);
    const schedule = await this.scheduleService.inspect(scheduleId);
    if (schedule.target.type !== "agent" || schedule.target.agentId !== callerAgent.id) {
      throw new Error(`Heartbeat ${scheduleId} does not belong to caller ${callerAgentId}`);
    }
  }

  private toScheduleSummary(
    schedule: Awaited<ReturnType<ScheduleService["inspect"]>>,
  ): Extract<
    SessionOutboundMessage,
    { type: "schedule/list/response" }
  >["payload"]["schedules"][number] {
    const { runs: _runs, ...summary } = schedule;
    return summary;
  }

  private emitScheduleRpcError(
    request: Extract<
      SessionInboundMessage,
      {
        type:
          | "schedule/create"
          | "schedule/list"
          | "schedule/inspect"
          | "schedule/logs"
          | "schedule/pause"
          | "schedule/resume"
          | "schedule/delete"
          | "schedule/run-once"
          | "schedule/update";
      }
    >,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Schedule request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "schedule_request_failed",
      },
    });
  }

  async handleScheduleCreateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/create" }>,
  ): Promise<void> {
    try {
      if (request.expiresAt !== undefined && request.expiresIn !== undefined) {
        throw new Error("Specify at most one of expiresAt or expiresIn");
      }
      if (request.callerContext && request.callerAgentId) {
        throw new Error("Specify callerContext or callerAgentId, not both");
      }
      let target: ScheduleTarget;
      if (request.callerContext) {
        target = resolveNewAgentScheduleTarget({
          callerAgent: this.requireCallerAgent(request.callerContext.agentId),
          overrides: request.callerContext,
        });
      } else if (request.target.type === "self") {
        target = { type: "agent", agentId: request.target.agentId };
      } else {
        target = request.target;
      }
      if (request.callerContext && request.target.type !== "new-agent") {
        throw new Error("Caller runtime can only be used for a new-agent schedule");
      }
      if (request.callerAgentId) {
        this.requireCallerAgent(request.callerAgentId);
        if (target.type !== "agent" || target.agentId !== request.callerAgentId) {
          throw new Error("Heartbeat target must match caller agent");
        }
      }
      const input = {
        prompt: request.prompt,
        name: request.name,
        cadence: request.cadence,
        target,
        maxRuns: request.maxRuns,
        expiresAt:
          request.expiresAt ?? scheduleExpiryFromDuration({ expiresIn: request.expiresIn }),
        runOnCreate: request.runOnCreate,
      };
      const schedule = request.replaceExisting
        ? await this.scheduleService.createOrReplace(input)
        : await this.scheduleService.create(input);
      this.host.emit({
        type: "schedule/create/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleListRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/list" }>,
  ): Promise<void> {
    try {
      const schedules = await this.scheduleService.list();
      this.host.emit({
        type: "schedule/list/response",
        payload: {
          requestId: request.requestId,
          schedules: schedules.map((schedule) => this.toScheduleSummary(schedule)),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleInspectRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/inspect" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.inspect(request.scheduleId);
      this.host.emit({
        type: "schedule/inspect/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleLogsRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/logs" }>,
  ): Promise<void> {
    try {
      const runs = await this.scheduleService.logs(request.scheduleId);
      this.host.emit({
        type: "schedule/logs/response",
        payload: {
          requestId: request.requestId,
          runs,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleSchedulePauseRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/pause" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.pause(request.scheduleId);
      this.host.emit({
        type: "schedule/pause/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleResumeRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/resume" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.resume(request.scheduleId);
      this.host.emit({
        type: "schedule/resume/response",
        payload: {
          requestId: request.requestId,
          schedule: this.toScheduleSummary(schedule),
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/delete" }>,
  ): Promise<void> {
    try {
      if (request.callerAgentId) {
        await this.requireOwnedHeartbeat(request.scheduleId, request.callerAgentId);
      }
      await this.scheduleService.delete(request.scheduleId);
      this.host.emit({
        type: "schedule/delete/response",
        payload: {
          requestId: request.requestId,
          scheduleId: request.scheduleId,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleRunOnceRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/run-once" }>,
  ): Promise<void> {
    try {
      const schedule = await this.scheduleService.runOnce(request.scheduleId);
      this.host.emit({
        type: "schedule/run-once/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }

  async handleScheduleUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "schedule/update" }>,
  ): Promise<void> {
    try {
      if (request.expiresAt !== undefined && request.expiresIn !== undefined) {
        throw new Error("Specify at most one of expiresAt or expiresIn");
      }
      if (request.callerAgentId) {
        await this.requireOwnedHeartbeat(request.scheduleId, request.callerAgentId);
      }
      let expiresAt: string | null | undefined;
      if (request.expiresAt !== undefined) {
        expiresAt = request.expiresAt;
      } else if (request.expiresIn !== undefined) {
        expiresAt = scheduleExpiryFromDuration({ expiresIn: request.expiresIn });
      }
      const schedule = await this.scheduleService.update({
        id: request.scheduleId,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(request.cadence !== undefined ? { cadence: request.cadence } : {}),
        ...(request.newAgentConfig !== undefined ? { newAgentConfig: request.newAgentConfig } : {}),
        ...(request.maxRuns !== undefined ? { maxRuns: request.maxRuns } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      this.host.emit({
        type: "schedule/update/response",
        payload: {
          requestId: request.requestId,
          schedule,
          error: null,
        },
      });
    } catch (error) {
      this.emitScheduleRpcError(request, error);
    }
  }
}
