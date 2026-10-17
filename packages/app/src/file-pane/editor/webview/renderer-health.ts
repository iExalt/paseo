/** Consecutive renderer failures, with no ready editor between them, that end editing. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface RendererHealth {
  failures: number;
  unavailable: boolean;
}

export const HEALTHY_RENDERER: RendererHealth = { failures: 0, unavailable: false };

/**
 * A crash loop leaves the file read-only. Platforms kill idle WebView renderers
 * routinely, so a renderer that comes back ready starts the count again.
 */
export function nextRendererHealth(
  health: RendererHealth,
  event: "ready" | "failure",
): RendererHealth {
  if (health.unavailable) return health;
  if (event === "ready") return HEALTHY_RENDERER;
  const failures = health.failures + 1;
  return { failures, unavailable: failures >= MAX_CONSECUTIVE_FAILURES };
}
