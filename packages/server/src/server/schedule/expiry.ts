import { parseDurationString } from "../agent/mcp-shared.js";

export function scheduleExpiryFromDuration(input: { expiresIn?: string }): string | undefined {
  if (input.expiresIn === undefined) return undefined;
  return new Date(Date.now() + parseDurationString(input.expiresIn)).toISOString();
}
