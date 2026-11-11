import { parseAndroidNotificationLifecycle } from "@getpaseo/protocol/android-notification-lifecycle";
import type { NotificationEpisode } from "./lifecycle-store.js";
import type pino from "pino";
import { randomUUID } from "node:crypto";
import { encodeAndroidAgentTag } from "@getpaseo/protocol/android-notification-tag";
import { boundNotificationPreview } from "@getpaseo/protocol/notification-preview";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  lifecycle?: NotificationEpisode;
}

interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  priority?: "normal" | "high";
  ttl?: number;
  contentAvailable?: boolean;
  sound?: "default";
  tag?: string;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** What Expo said about one notification: a ticket, not proof of delivery. */
export type PushDeliveryOutcome = { outcome: "accepted" } | { outcome: "failed"; error: string };

type BatchResult = { tickets: ExpoPushTicket[] } | { error: string };

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;
const EXPO_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;

  constructor(logger: pino.Logger, revokeToken: (token: string) => void) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    const data = payload.data;
    const reason = data?.reason;
    const tag =
      typeof data?.serverId === "string" &&
      typeof data.agentId === "string" &&
      (reason === "finished" || reason === "error" || reason === "permission")
        ? encodeAndroidAgentTag({
            serverId: data.serverId,
            agentId: data.agentId,
            reason,
            nonce: randomUUID(),
          })
        : null;
    const messages = tokens.map((token) => toExpoMessage(token, payload, tag));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    await Promise.all(batches.map((batch) => this.sendBatch(batch)));
  }

  async sendLifecycle(
    subscriptions: Array<{ token: string; registrationId: string }>,
    serverId: string,
    episode: NotificationEpisode,
    payload?: PushPayload,
  ): Promise<boolean> {
    const messages: ExpoPushMessage[] = [];
    for (const subscription of subscriptions) {
      const event = parseAndroidNotificationLifecycle(
        {
          v: 1,
          serverId,
          ...episode,
          registrationId: subscription.registrationId,
          operation: payload ? "alert" : "resolve",
          ...(payload
            ? {
                reason: payload.data?.reason,
                preview: { title: payload.title.slice(0, 220), body: payload.body.slice(0, 1000) },
                workspaceId: payload.data?.workspaceId,
              }
            : {}),
        },
        Date.now(),
      );
      if (!event) continue;
      const message: ExpoPushMessage = {
        to: subscription.token,
        contentAvailable: true,
        priority: payload ? "high" : "normal",
        ttl: payload ? Math.max(1, Math.ceil((episode.expiresAt - Date.now()) / 1000)) : 86_400,
        data: {
          paseoLifecycle: event,
          ...(payload?.data?.preview ? { preview: payload.data.preview } : {}),
        },
      };
      let bounded = boundNotificationPreview(message, 4000);
      // Nested preview must fit without dropping identity, expiry or tombstones.
      if (new TextEncoder().encode(JSON.stringify(bounded)).byteLength > 4000) {
        if (event.operation === "alert")
          event.preview = { title: "Paseo", body: "Open Paseo to view this update." };
        bounded = boundNotificationPreview(message, 4000);
      }
      if (new TextEncoder().encode(JSON.stringify(bounded)).byteLength > 4000)
        throw new Error("Notification lifecycle identity exceeds push budget");
      messages.push(bounded);
    }
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      const batch = messages.slice(i, i + MAX_BATCH_SIZE);
      const result = await this.postBatch(batch);
      if ("error" in result) return false;
      this.handleTickets(batch, result.tickets);
      if (
        result.tickets.length !== batch.length ||
        result.tickets.some((ticket) => ticket.status !== "ok")
      )
        return false;
    }
    return true;
  }

  /** Send to one device and report Expo's answer, for a user-requested test. */
  async sendOne(token: string, payload: PushPayload): Promise<PushDeliveryOutcome> {
    const message = toExpoMessage(token, payload);
    const result = await this.postBatch([message]);
    if ("error" in result) return { outcome: "failed", error: result.error };
    this.handleTickets([message], result.tickets);
    const ticket = result.tickets[0];
    if (ticket?.status === "ok") return { outcome: "accepted" };
    return {
      outcome: "failed",
      error: ticket?.message ?? ticket?.details?.error ?? "Expo returned no ticket",
    };
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<void> {
    const result = await this.postBatch(messages);
    if ("tickets" in result) this.handleTickets(messages, result.tickets);
  }

  /** Errors are logged and returned, never thrown. */
  private async postBatch(messages: ExpoPushMessage[]): Promise<BatchResult> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
        // A hung Expo request must not hold a test request open after the app gave up.
        signal: AbortSignal.timeout(EXPO_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return { error: `Expo push API error ${response.status} ${response.statusText}`.trim() };
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      return { tickets: result.data };
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private handleTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): void {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (
          ticket.details?.error === "DeviceNotRegistered" ||
          ticket.details?.error === "InvalidCredentials"
        ) {
          this.revokeToken(message.to);
        }
      }
    }
  }
}

function toExpoMessage(token: string, payload: PushPayload, tag?: string | null): ExpoPushMessage {
  const ordinary = boundNotificationPreview(
    {
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default" as const,
    },
    4_000,
  );
  if (!tag) return ordinary;
  const tagged = { ...ordinary, tag };
  return new TextEncoder().encode(JSON.stringify(tagged)).byteLength <= 4_000 ? tagged : ordinary;
}
