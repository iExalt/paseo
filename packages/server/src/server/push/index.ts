import type { NotificationEpisode } from "./lifecycle-store.js";
import type pino from "pino";

import { PushService, type PushDeliveryOutcome, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushDeliveryOutcome, PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string, registrationId?: string | null): void;
  resolveLifecycle?(serverId: string, episode: NotificationEpisode): Promise<boolean>;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
  /** Send to one registered device and report Expo's answer. */
  sendTest(token: string, payload: PushPayload): Promise<PushDeliveryOutcome>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
  deliverOne?: (token: string, payload: PushPayload) => Promise<PushDeliveryOutcome>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));
  const deliverOne =
    options.deliverOne ??
    ((token: string, payload: PushPayload) => service.sendOne(token, payload));

  return {
    renew(token, registrationId) {
      store.renewToken(token, registrationId);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const subscriptions = store.getActiveSubscriptions();
      // Only explicitly capable Android registrations receive app-owned payloads.
      const managedKind =
        typeof payload.data?.serverId === "string" &&
        typeof payload.data.agentId === "string" &&
        (payload.data.reason === "finished" || payload.data.reason === "permission");
      const legacy = subscriptions.filter((sub) => !sub.registrationId || !managedKind);
      if (legacy.length)
        await deliver(
          legacy.map((sub) => sub.token),
          payload,
        );
      if (payload.lifecycle && typeof payload.data?.serverId === "string") {
        const managed = subscriptions.filter(
          (sub): sub is { token: string; registrationId: string } => !!sub.registrationId,
        );
        if (
          !(await service.sendLifecycle(managed, payload.data.serverId, payload.lifecycle, payload))
        )
          throw new Error("Expo did not accept managed alert");
      }
    },
    resolveLifecycle(serverId, episode) {
      const subscriptions = store
        .getActiveSubscriptions()
        .filter((sub): sub is { token: string; registrationId: string } => !!sub.registrationId);
      return service.sendLifecycle(subscriptions, serverId, episode);
    },
    sendTest(token, payload) {
      return deliverOne(token, payload);
    },
  };
}
