import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { ListResult } from "../../output/index.js";
import {
  permitResponseSchema,
  toPermissionResponseItem,
  type PermissionResponseItem,
  type PermitClient,
} from "./allow.js";

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

export async function settlePermissionResponses({
  client,
  agentId,
  permissions,
  response,
  validate,
}: {
  client: PermitClient;
  agentId: string;
  permissions: AgentPermissionRequest[];
  response: AgentPermissionResponse;
  validate?: (permission: AgentPermissionRequest, response: AgentPermissionResponse) => void;
}): Promise<ListResult<PermissionResponseItem>> {
  // Validate the entire selection before dispatch; one invalid question must not partially allow it.
  const errors = permissions.map((permission) => {
    try {
      validate?.(permission, response);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  });
  const invalid = errors.some((error) => error !== undefined);
  const data = await Promise.all(
    permissions.map(async (permission, index): Promise<PermissionResponseItem> => {
      const item = toPermissionResponseItem(
        agentId,
        permission,
        response.behavior === "allow" ? "allowed" : "denied",
      );
      if (invalid)
        return {
          ...item,
          result: "failed",
          status: "failed",
          error: errors[index] ?? "Batch validation failed; response not sent.",
        };
      try {
        // The SDK bounds each confirmation by its existing 15-second request deadline.
        await client.respondToPermissionAndWait(agentId, permission.id, { ...response });
        return item;
      } catch (error) {
        // An opaque rejection may follow dispatch or provider side effects. Never infer that it was unapplied.
        return { ...item, result: "unconfirmed", status: "unconfirmed", error: messageOf(error) };
      }
    }),
  );
  return {
    type: "list",
    data,
    schema: permitResponseSchema,
    ...(data.some((item) => item.status !== "confirmed") ? { exitCode: 1 as const } : {}),
  };
}
