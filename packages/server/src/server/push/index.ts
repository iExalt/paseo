import type pino from "pino";

import { PushService, type PushDeliveryOutcome, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushDeliveryOutcome, PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
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
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
    sendTest(token, payload) {
      return deliverOne(token, payload);
    },
  };
}
