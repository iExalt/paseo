// One grep-able line per state change agents need to observe without screenshots:
// `[paseo-agent] <area> <event> key=value ...` on logcat's ReactNativeJS tag and the web console.
// docs/agent-testing.md#agent-log-lines lists the events.

export type AgentLogArea = "link" | "connection" | "push" | "update";
export type AgentLogValue = string | number | boolean | null | undefined;

const MAX_VALUE_LENGTH = 160;

// Pairing links put their key material after `#`; relay URIs and Expo tokens are secrets too.
function redact(value: string): string {
  return value
    .replace(/#\S*/g, "#…")
    .replace(/relay:\/\/\S*/g, "relay://…")
    .replace(/ExponentPushToken\[[^\]]*\]/g, "ExponentPushToken[…]");
}

function formatValue(value: AgentLogValue): string {
  const text = redact(String(value));
  const capped = text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
  return /[\s="]/.test(capped) ? JSON.stringify(capped) : capped;
}

export function formatAgentLog(
  area: AgentLogArea,
  event: string,
  fields: Record<string, AgentLogValue> = {},
): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return ["[paseo-agent]", area, event, ...parts].join(" ");
}

export function agentLog(
  area: AgentLogArea,
  event: string,
  fields: Record<string, AgentLogValue> = {},
): void {
  // console.info, not warn: a dev build shows warnings as LogBox toasts over the UI under test.
  console.info(formatAgentLog(area, event, fields));
}

/** The error's class and message, for a `reason=` field. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
