import { z } from "zod";

/** Bounds transport TTL and the minimum time a resolved episode must remain remembered. */
export const ANDROID_NOTIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const ANDROID_NOTIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const identity = z.string().min(1).max(512);
const common = {
  v: z.literal(1),
  serverId: identity,
  agentId: identity,
  registrationId: z.uuid(),
  episodeId: z.uuid(),
  lane: z.enum(["attention", "question"]),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
};

export const AndroidNotificationLifecycleSchema = z.discriminatedUnion("operation", [
  z.object({
    ...common,
    operation: z.literal("alert"),
    reason: z.enum(["finished", "permission"]),
    preview: z.object({ title: z.string().max(220), body: z.string().max(1_000) }),
    workspaceId: identity.optional(),
  }),
  z.object({ ...common, operation: z.literal("resolve") }),
]);

export type AndroidNotificationLifecycle = z.infer<typeof AndroidNotificationLifecycleSchema>;

/** Managed content stays nested; Expo's native title/message keys must remain absent. */
export function parseAndroidNotificationLifecycle(
  value: unknown,
  now: number,
): AndroidNotificationLifecycle | null {
  const result = AndroidNotificationLifecycleSchema.safeParse(value);
  if (!result.success) return null;
  const event = result.data;
  if (
    event.expiresAt <= event.issuedAt ||
    event.expiresAt - event.issuedAt > ANDROID_NOTIFICATION_LIFETIME_MS ||
    event.issuedAt > now + ANDROID_NOTIFICATION_CLOCK_SKEW_MS
  )
    return null;
  // A late resolution still removes a visible old row. Expired alerts never create one.
  if (event.operation === "alert") {
    if (event.expiresAt <= now) return null;
    if ((event.reason === "permission") !== (event.lane === "question")) return null;
  }
  return event;
}
