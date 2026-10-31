import { agentLog } from "@/utils/agent-log";
import { addSwitchesListener, takeLaunchSwitches } from "./agent-switches-source";

// Run-time switches for agents testing a diagnostic build: docs/agent-testing.md#debug-switches.
// Only bundles built with EXPO_PUBLIC_PASEO_AGENT_SWITCHES=1 read them. Keep every check a direct
// comparison so other bundles fold it to false and drop the code behind it.
export const AGENT_SWITCHES_ENABLED = process.env.EXPO_PUBLIC_PASEO_AGENT_SWITCHES === "1";

const ALLOWED_VALUES = {
  trace: ["terminal-input", "terminal-input:full"],
  // Stops the running turn's one-second elapsed tick, which keeps uiautomator from going idle.
  clock: ["frozen"],
  // Skips the notification permission prompt, which takes focus on a fresh install.
  notifications: ["skip"],
  // Shows the preferences Transfer row outside the packages that own it.
  transfer: ["bridge", "receiver"],
} as const;

export type AgentSwitchKey = keyof typeof ALLOWED_VALUES;
export type AgentSwitches = {
  [Key in AgentSwitchKey]?: (typeof ALLOWED_VALUES)[Key][number];
};

// Values are checked against ALLOWED_VALUES before they are stored.
let current: Partial<Record<AgentSwitchKey, string>> = {};
let loaded = false;
const listeners = new Set<() => void>();

function isSwitchKey(key: string): key is AgentSwitchKey {
  return Object.hasOwn(ALLOWED_VALUES, key);
}

/** Applies raw key/value pairs; `off` clears a key. Unknown keys and values are logged and skipped. */
export function applyAgentSwitches(raw: Record<string, string>): void {
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    if (!isSwitchKey(key)) {
      agentLog("debug", "rejected", { key, reason: "unknown-key" });
      continue;
    }
    if (value === "off") {
      delete next[key];
      agentLog("debug", "set", { key, value });
      continue;
    }
    if (!(ALLOWED_VALUES[key] as readonly string[]).includes(value)) {
      agentLog("debug", "rejected", { key, reason: "unknown-value" });
      continue;
    }
    next[key] = value;
    agentLog("debug", "set", { key, value });
  }
  current = next;
  for (const listener of listeners) listener();
}

/** Reads the launch switches once. Call it at startup so they apply before anything reads them. */
export function loadAgentSwitches(): void {
  if (!AGENT_SWITCHES_ENABLED || loaded) return;
  loaded = true;
  applyAgentSwitches(takeLaunchSwitches());
  addSwitchesListener(applyAgentSwitches);
}

export function readAgentSwitch<Key extends AgentSwitchKey>(key: Key): AgentSwitches[Key] {
  if (!AGENT_SWITCHES_ENABLED) return undefined;
  loadAgentSwitches();
  return current[key] as AgentSwitches[Key];
}

export function subscribeAgentSwitches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
