import type { CommandError } from "../../output/index.js";

interface ProviderModesSnapshot {
  entries: Array<{ provider: string; modes?: Array<{ id: string; label?: string }> | null }>;
}

interface ProvidersSnapshotClient {
  getProvidersSnapshot(): Promise<ProviderModesSnapshot>;
}

/**
 * The daemon validates the mode only when it creates the agent, after `run` has already
 * created the agent's new workspace, so an invalid mode used to leave an empty workspace
 * behind. Check it first. Fails open: when the snapshot is unavailable or lists no modes,
 * the daemon's own validation still applies.
 */
export async function assertModeBeforeWorkspaceCreate(
  client: ProvidersSnapshotClient,
  provider: string,
  mode: string | undefined,
): Promise<void> {
  const requested = mode?.trim();
  if (!requested) return;
  let modes: Array<{ id: string; label?: string }>;
  try {
    const snapshot = await client.getProvidersSnapshot();
    modes = snapshot.entries.find((entry) => entry.provider === provider)?.modes ?? [];
  } catch {
    return;
  }
  if (modes.length === 0 || modes.some((candidate) => candidate.id === requested)) return;

  const byLabel = modes.find(
    (candidate) => candidate.label?.toLowerCase() === requested.toLowerCase(),
  );
  const ids = modes.map((candidate) => candidate.id).join(", ");
  throw {
    code: "INVALID_MODE",
    message: byLabel
      ? `Invalid mode '${requested}' for provider '${provider}': that is a label; use the mode id '${byLabel.id}'.`
      : `Invalid mode '${requested}' for provider '${provider}'. Available modes: ${ids}`,
    details: `List mode ids with "paseo provider inspect ${provider}". No workspace was created.`,
  } satisfies CommandError;
}
