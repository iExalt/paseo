import { attemptLedger } from "../.github/scripts/candidate-attempts.mjs";

// Serves a run whose listed jobs all executed in `attempt`, with earlier
// attempts empty, so tests exercise the real producer-attempt resolution.
export function attemptRoute(route, jobs, attempt, runId = 500) {
  const match = route.match(new RegExp(`/actions/runs/${runId}/attempts/(\\d+)(/jobs)?`));
  if (!match) return null;
  const number = Number(match[1]);
  if (match[2]) return { jobs: number === attempt ? jobs : [] };
  return { id: runId, run_attempt: number, run_started_at: "2026-10-12T11:00:00Z" };
}

export function ledgerFor(jobs, attempt = 2, runId = 500) {
  return attemptLedger({ runId, attempt }, async (route) =>
    attemptRoute(route, jobs, attempt, runId),
  );
}
