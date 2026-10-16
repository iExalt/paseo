import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
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

    const messages = tokens.map((token) => toExpoMessage(token, payload));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    await Promise.all(batches.map((batch) => this.sendBatch(batch)));
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

function toExpoMessage(token: string, payload: PushPayload): ExpoPushMessage {
  return {
    to: token,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    sound: "default",
  };
}
