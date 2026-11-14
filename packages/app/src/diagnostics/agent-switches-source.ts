// Web: switches come from sessionStorage, so they last for one tab. A Playwright probe sets them
// with `addInitScript(() => sessionStorage.setItem("paseo.agentSwitches", JSON.stringify({...})))`.
const STORAGE_KEY = "paseo.agentSwitches";

export function takeLaunchSwitches(): Record<string, string> {
  if (typeof sessionStorage === "undefined") return {};
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function addSwitchesListener(_listener: (switches: Record<string, string>) => void): void {}
